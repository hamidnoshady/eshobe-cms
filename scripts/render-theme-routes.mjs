#!/usr/bin/env node
/**
 * Render `theme-routes.caddy` from the CMS's own routing table, from outside the CMS.
 *
 * WAVE-11 §5 Option A: Caddy stays the edge for a site that adopted a deployable
 * theme, holding its certificate and keeping every `/api/*` carve-out pointed at
 * `web:3000`, while its *pages* proxy to the theme application. Caddy therefore
 * needs a host → upstream map, and a map a human maintains is one forgotten line
 * away from a customer's domain serving another customer's shop.
 *
 * The application regenerates this file itself after every routing-affecting
 * transition when `THEME_ROUTES_FILE` is set (src/deploy/routing.ts). This script is
 * the manual/cron path for a topology where the web process cannot write the file
 * Caddy reads:
 *
 *   CMS_URL=https://admin.example.com \
 *   PLATFORM_API_KEY=eshobe_live_… \
 *   node scripts/render-theme-routes.mjs /etc/caddy/theme-routes/theme-routes.caddy
 *
 * Caddy picks the change up by itself when it runs with `--watch` (as
 * docker-compose.prod.yml configures it); otherwise follow with `caddy reload`. The
 * script writes atomically and exits non-zero without touching the file if the API is
 * unreachable or answers something unexpected — a routing table truncated by a
 * transient 502 would take every themed site offline at once, which is a far worse
 * outcome than a stale one.
 */

import { dirname, resolve } from 'node:path'

import { renderThemeRoutes, writeThemeRoutes } from '../src/lib/deploy/theme-routes.mjs'

const output = resolve(process.argv[2] ?? 'theme-routes.caddy')
const cmsUrl = (process.env.CMS_URL ?? '').replace(/\/+$/, '')
const apiKey = process.env.PLATFORM_API_KEY ?? ''

const die = (message) => {
  console.error(`render-theme-routes: ${message}`)
  process.exit(1)
}

if (!cmsUrl) die('CMS_URL is required.')
if (!apiKey) die('PLATFORM_API_KEY is required (a role: "platform" key).')

let payload
try {
  const response = await fetch(`${cmsUrl}/api/platform/routing`, {
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) die(`CMS answered ${response.status}.`)
  payload = await response.json()
} catch (error) {
  die(`could not reach the CMS: ${error.message}`)
}

if (!payload?.ok || !Array.isArray(payload.routes)) die('unexpected response shape.')

const rendered = renderThemeRoutes(payload.routes, {
  generatedAt: payload.generatedAt,
  source: `${cmsUrl}/api/platform/routing`,
})

for (const warning of rendered.skipped) console.warn(`render-theme-routes: skipping ${warning}`)

const outcome = writeThemeRoutes(output, rendered.text)

console.log(
  outcome === 'unchanged'
    ? `render-theme-routes: unchanged (${rendered.count} routes)`
    : `render-theme-routes: wrote ${rendered.count} routes to ${output} (${dirname(output)})`,
)
