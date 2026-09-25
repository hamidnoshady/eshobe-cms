import type { Payload, PayloadRequest } from 'payload'

import { idOf } from '@/lib/ids'
import { renderThemeRoutes, writeThemeRoutes } from '@/lib/deploy/theme-routes.mjs'

/**
 * The Caddy routing table for `edge`-mode deployments, and keeping
 * `theme-routes.caddy` in step with it.
 *
 * ## One table, two consumers
 *
 * `GET /api/platform/routing` serves it to `scripts/render-theme-routes.mjs` (the
 * manual/cron path), and `regenerateThemeRoutes` renders it in-process. Both go
 * through `buildRoutingTable`, so "which hosts are themed" has a single answer.
 *
 * ## Why regeneration is requested, not performed, by the deploy service
 *
 * A promote, a stop, a suspension or a domain change each alter the table, and each
 * happens inside some other write — often inside that write's transaction. Reading
 * the table there would either see uncommitted rows or block the write on file I/O.
 * So a transition only *requests* a regeneration: requests are coalesced for a
 * moment, then one regeneration reads the committed state on a fresh connection and
 * writes the file atomically. A failure is logged and never reaches the transition
 * that asked — a deployment that went live stays live because a file could not be
 * written.
 *
 * `THEME_ROUTES_FILE` names the file (as this process sees it). Unset means this
 * process does not own the map, and every request is a no-op; the script is then the
 * way to produce it.
 */

export type ThemeRoute = { host: string; upstream: string }

const COALESCE_MS = 1000

/**
 * Every host Caddy should proxy to a theme application, and where to.
 *
 * Only rows that are genuinely safe to serve through the edge:
 *
 *  - `live` and `edge` — a `preview` is reached on the target's wildcard and a
 *    `direct` one has left Caddy entirely;
 *  - on an `active` site — a suspended customer's storefront must fall back to the
 *    holding page `web:3000` renders, not keep working through its theme;
 *  - whose primary domain is verified — an unverified hostname gets no certificate
 *    and resolves no tenant;
 *  - whose `domain` is still the site's `domain` — a deployment built before a
 *    domain change is stale, and routing the new hostname to it would 404 every
 *    request; dropped, the new hostname falls through to the built-in renderer until
 *    a redeploy (`needsRedeploy`);
 *  - plus that site's *verified* aliases only.
 */
export const buildRoutingTable = async (
  payload: Payload,
  req?: PayloadRequest,
): Promise<ThemeRoute[]> => {
  const { docs } = await payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit: 500,
    overrideAccess: true,
    pagination: false,
    ...(req ? { req } : {}),
    sort: 'createdAt',
    where: { and: [{ status: { equals: 'live' } }, { domainMode: { equals: 'edge' } }] },
  })

  const rows = docs as unknown as Record<string, unknown>[]
  const siteIds = [...new Set(rows.map((row) => idOf(row.site)).filter(Boolean))] as string[]
  if (!siteIds.length) return []

  const { docs: siteDocs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: siteIds.length,
    overrideAccess: true,
    pagination: false,
    ...(req ? { req } : {}),
    where: { id: { in: siteIds } },
  })

  const sites = new Map(
    (siteDocs as unknown as Record<string, unknown>[]).map((site) => [String(site.id), site]),
  )

  const routes: ThemeRoute[] = []

  for (const row of rows) {
    const site = sites.get(String(idOf(row.site)))
    const upstream = String(row.previewDomain ?? '')
    if (!site?.domain || !upstream) continue
    if (String(site.status ?? '') !== 'active') continue
    if (site.domainVerified !== true) continue

    const host = String(row.domain ?? '')
    if (!host || host !== String(site.domain)) continue

    routes.push({ host, upstream })

    for (const alias of Array.isArray(site.domains) ? site.domains : []) {
      const entry = alias as { hostname?: unknown; verified?: unknown }
      if (entry?.verified === true && entry.hostname) {
        routes.push({ host: String(entry.hostname), upstream })
      }
    }
  }

  return routes
}

export type RegenerationResult =
  | { count: number; file: string; outcome: 'unchanged' | 'written' }
  | { outcome: 'disabled' }

const routesFile = (): null | string => process.env.THEME_ROUTES_FILE?.trim() || null

/** Build, render and atomically write the map now. Throws on failure; the file is untouched. */
export const regenerateThemeRoutes = async (payload: Payload): Promise<RegenerationResult> => {
  const file = routesFile()
  if (!file) return { outcome: 'disabled' }

  const routes = await buildRoutingTable(payload)
  const rendered = renderThemeRoutes(routes, { source: 'eshobe-cms (in-process)' })
  for (const warning of rendered.skipped) payload.logger.warn({ msg: `theme routes: skipped ${warning}` })

  return { count: rendered.count, file, outcome: writeThemeRoutes(file, rendered.text) }
}

let timer: null | ReturnType<typeof setTimeout> = null
let pendingPayload: null | Payload = null
let pendingReasons: string[] = []

const runPending = async (): Promise<null | RegenerationResult> => {
  const payload = pendingPayload
  const reasons = pendingReasons
  timer = null
  pendingPayload = null
  pendingReasons = []
  if (!payload) return null

  try {
    const result = await regenerateThemeRoutes(payload)
    if (result.outcome === 'written') {
      payload.logger.info({
        msg: `theme routes: wrote ${result.count} routes to ${result.file} (${reasons.join('; ')})`,
      })
    }
    return result
  } catch (error) {
    payload.logger.error({
      err: error as Error,
      msg: `theme routes: regeneration failed, previous map left in place (${reasons.join('; ')})`,
    })
    return null
  }
}

/**
 * Ask for `theme-routes.caddy` to be regenerated. Returns immediately and never
 * throws; see the module header for why this is a request.
 */
export const requestThemeRoutesRegeneration = (req: PayloadRequest, reason: string): void => {
  if (!routesFile()) return

  pendingPayload = req.payload
  pendingReasons.push(reason)
  if (timer) return

  timer = setTimeout(() => {
    void runPending()
  }, COALESCE_MS)
}

/** Whether a regeneration has been requested and not yet run. */
export const themeRoutesRegenerationPending = (): boolean => timer !== null

/** Run a pending regeneration now instead of after the coalescing delay. */
export const flushThemeRoutesRegeneration = async (): Promise<null | RegenerationResult> => {
  if (!timer) return null
  clearTimeout(timer)
  return runPending()
}
