import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * WAVE-9 §9.4 — the edge half of the headless contract.
 *
 * Collection access now fails closed when an HTTP request has neither a tenant
 * Host nor a credential, but the production proxy should still stop the old
 * fail-open URL before it reaches Node: anonymous reads on the control-plane
 * host (`https://admin.example.com/api/pages`, GraphQL, `/api/site`, etc.). This
 * is a static regression test because the sandbox test environment has no Caddy
 * binary; the deployment smoke test validates the full compose stack.
 */
const caddyfile = readFileSync(resolve(process.cwd(), 'Caddyfile'), 'utf8')

const indexOf = (needle: string): number => {
  const index = caddyfile.indexOf(needle)
  expect(index, `missing ${needle}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('Caddyfile control-plane API guard', () => {
  it('carves out authenticated API calls before blocking anonymous reads', () => {
    const controlPlane = indexOf('https://{$CONTROL_PLANE_HOST} {')
    const bearer = indexOf('@api_with_bearer')
    const session = indexOf('@api_with_session')
    const anonymousReads = indexOf('@anonymous_control_plane_api_reads')
    const finalProxy = caddyfile.indexOf(
      '    handle {\n        reverse_proxy web:3000\n    }',
      anonymousReads,
    )

    expect(bearer).toBeGreaterThan(controlPlane)
    expect(session).toBeGreaterThan(controlPlane)
    expect(anonymousReads).toBeGreaterThan(bearer)
    expect(anonymousReads).toBeGreaterThan(session)
    expect(finalProxy).toBeGreaterThan(anonymousReads)
  })

  it('blocks every public content read surface and anonymous GraphQL on the control plane', () => {
    const publicReadSurfaces = [
      '/api/site',
      '/api/pages',
      '/api/posts',
      '/api/products',
      '/api/categories',
      '/api/media',
      '/api/theme',
      '/api/header',
      '/api/footer',
      '/api/store',
      '/api/search',
      '/api/redirects',
      '/api/forms',
      '/api/payments/methods',
    ]

    const guard = caddyfile.slice(
      indexOf('@anonymous_control_plane_api_reads'),
      indexOf('handle @anonymous_control_plane_api_reads'),
    )

    expect(guard).toContain('method GET HEAD')
    for (const surface of publicReadSurfaces) expect(guard).toContain(surface)

    const graphqlGuard = caddyfile.slice(
      indexOf('@anonymous_control_plane_graphql'),
      indexOf('handle @anonymous_control_plane_graphql'),
    )
    expect(graphqlGuard).toContain('/api/graphql')
  })
})

/**
 * WAVE-11 §5 Option A — the theme upstream must not be able to swallow the API.
 *
 * A site with a deployed theme keeps its certificate and its `/api/*` carve-outs on
 * this edge; only its *pages* proxy onward. That property is entirely a matter of
 * directive order in one file, and getting it backwards is silent: checkout, the
 * contact form and media would start 404ing on every themed customer's domain while
 * the homepage looked perfect.
 */
describe('Caddyfile theme upstream', () => {
  it('routes every API carve-out to web:3000 before the theme matcher is reached', () => {
    const themed = indexOf('@themed')

    for (const carveOut of [
      '@form_submissions',
      '@checkout',
      '@payment_methods',
      '@site_descriptor',
      '@media_files',
      '@site_domain',
      '@site_domains',
      '@cms_content',
    ]) {
      expect(indexOf(carveOut), `${carveOut} must precede @themed`).toBeLessThan(themed)
    }
  })

  it('keeps the control-plane 404 and the web fallback after the theme matcher', () => {
    const themed = indexOf('@themed')

    // `/admin*` on a customer domain stays a 404 even when a theme is serving that
    // domain's pages — a theme upstream must never become a route to the admin panel.
    expect(caddyfile.indexOf('@control_plane_paths', themed)).toBeGreaterThan(themed)
    // And a site with no theme still falls through to the built-in renderer, which is
    // what makes `default ""` in the generated map the safe state.
    expect(
      caddyfile.indexOf('    handle {\n        reverse_proxy web:3000\n    }', themed),
    ).toBeGreaterThan(themed)
  })

  it('imports the generated map, and the committed map falls through by default', () => {
    expect(caddyfile).toContain('import /etc/caddy/theme-routes/theme-routes.caddy')

    const routes = readFileSync(resolve(process.cwd(), 'theme-routes.caddy'), 'utf8')

    // Committed empty-by-default and committed *at all*: a missing import is a Caddy
    // that will not start, so a deployment with no themes still needs this file.
    expect(routes).toContain('map {host} {theme_upstream}')
    expect(routes).toContain('default ""')
  })

  it('sends the upstream its own Host and preserves the public one separately', () => {
    const themed = indexOf('@themed')
    // From the matcher to the directive that follows it. `indexOf('@control_plane_paths')`
    // would find the prose mention 100 lines *earlier* and slice backwards to nothing —
    // a test that passes by measuring an empty string is worse than no test.
    const block = caddyfile.slice(themed, caddyfile.indexOf('@control_plane_paths path', themed))

    // The theme app answers on its preview hostname; forwarding the customer's Host
    // would hit a vhost Coolify does not have. The public origin travels in
    // X-Forwarded-Host (and in ESHOBE_PUBLIC_ORIGIN at build time).
    expect(block).toContain('header_up Host {theme_upstream}')
    expect(block).toContain('header_up X-Forwarded-Host {host}')
  })

  it('shares the map with Caddy through a directory volume it watches, not a bind-mounted file', () => {
    // The map is replaced by rename. A single-file bind mount pins the old inode, so
    // Caddy would keep reading the map from before the first regeneration; a
    // directory mount sees the rename. `--watch` is what applies it without a reload
    // command, a Docker socket or an admin API on the network.
    const compose = readFileSync(resolve(process.cwd(), 'docker-compose.prod.yml'), 'utf8')
    expect(compose).toContain('theme_routes:/etc/caddy/theme-routes:ro')
    expect(compose).toContain('theme_routes:/app/theme-routes')
    expect(compose).not.toContain('./theme-routes.caddy:/etc/caddy/theme-routes.caddy')
    expect(compose).toMatch(/command: \[.*'--watch'\]/)
    expect(compose).toContain('THEME_ROUTES_FILE: ${THEME_ROUTES_FILE:-/app/theme-routes/theme-routes.caddy}')

    // The image seeds that volume with the committed empty map, owned by the runtime user.
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8')
    expect(dockerfile).toContain(
      'COPY --from=builder --chown=nextjs:nodejs /app/theme-routes.caddy /app/theme-routes/theme-routes.caddy',
    )
  })
})
