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
