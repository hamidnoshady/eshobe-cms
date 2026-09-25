/**
 * Rendering and writing `theme-routes.caddy` — the host → theme-upstream map the
 * Caddyfile imports (docs/theme-deployments.md, "Routing").
 *
 * Plain JavaScript with no imports beyond `node:`, on purpose: it is shared by the
 * application (`src/deploy/routing.ts`, which regenerates the map after every
 * routing-affecting transition) and by `scripts/render-theme-routes.mjs`, which an
 * operator runs with bare `node` on a host that has no TypeScript toolchain.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

/** A lowercase DNS hostname with at least one dot. Anything else never reaches proxy configuration. */
export const ROUTE_HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/**
 * Render the map.
 *
 * Both sides of every route are validated here as well as in the CMS: this text
 * becomes configuration on a machine terminating TLS for every customer, and a
 * malformed hostname reaching it is either a Caddy that will not load it or one that
 * loads a rule nobody intended.
 *
 * Throws on a malformed input shape rather than rendering an empty map — an empty
 * map written over a populated one takes every themed site off its theme at once.
 *
 * @param {unknown} routes `[{ host, upstream }]` as `GET /api/platform/routing` returns them.
 * @param {{ generatedAt?: string, source?: string }} [meta]
 * @returns {{ count: number, skipped: string[], text: string }}
 */
export const renderThemeRoutes = (routes, meta = {}) => {
  if (!Array.isArray(routes)) throw new Error('routes must be an array')

  const lines = []
  const skipped = []
  const seen = new Set()

  for (const route of routes) {
    const host = String(route?.host ?? '').toLowerCase()
    const upstream = String(route?.upstream ?? '').toLowerCase()

    if (!ROUTE_HOST_PATTERN.test(host) || !ROUTE_HOST_PATTERN.test(upstream)) {
      skipped.push(`malformed route ${host} → ${upstream}`)
      continue
    }
    if (seen.has(host)) {
      skipped.push(`duplicate host ${host}, kept the first`)
      continue
    }
    seen.add(host)
    lines.push(`\t${host} ${upstream}`)
  }

  const text = [
    '# Generated from GET /api/platform/routing — do not edit by hand.',
    ...(meta.source ? [`# Source: ${meta.source}`] : []),
    `# Generated at: ${meta.generatedAt ?? new Date().toISOString()}`,
    `# Routes: ${lines.length}`,
    '',
    'map {host} {theme_upstream} {',
    '\tdefault ""',
    ...lines,
    '}',
    '',
  ].join('\n')

  return { count: lines.length, skipped, text }
}

/** The map without its header comments — what "did anything change?" compares. */
const body = (text) => text.slice(text.indexOf('map {host}'))

/**
 * Write the map atomically: a temporary file in the same directory, then a rename.
 * A reader — `caddy run --watch` polls every second — sees the old file or the new
 * one, never half of either.
 *
 * Skipped when only the header differs, so a regeneration that changed no route
 * does not touch the file (and does not make Caddy reload).
 *
 * @param {string} output
 * @param {string} text
 * @returns {'unchanged' | 'written'}
 */
export const writeThemeRoutes = (output, text) => {
  if (existsSync(output) && body(readFileSync(output, 'utf8')) === body(text)) return 'unchanged'

  const temporary = `${output}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, output)
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      /* the original error is the one worth reporting */
    }
    throw error
  }
  return 'written'
}
