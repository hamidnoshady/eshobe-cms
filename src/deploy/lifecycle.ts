import type { CollectionAfterChangeHook } from 'payload'

import { normalizeDomain } from '@/lib/domains'
import { idOf } from '@/lib/ids'

import { requestThemeRoutesRegeneration } from './routing'
import { stopSiteDeployments } from './service'

/**
 * What a site's own lifecycle does to its deployed theme — `sites.afterChange`.
 *
 * A hook on the collection rather than code in each endpoint, because a site's status
 * and domain are written from several places (the admin form, `PATCH
 * /api/platform/sites/:id`, `PATCH /api/site/domain`, the subscription lifecycle) and
 * every one of them has to have the same effect.
 *
 * ## Suspension and archival stop the application
 *
 * The routing table already drops an inactive site, so its customer domain falls
 * back to the holding page `web:3000` renders. That is not enough on its own: the
 * theme application is still running and reachable on its preview hostname, and in
 * `direct` mode the customer's DNS points at it rather than at Caddy. Leaving it up
 * means the one customer who stopped paying is the one whose storefront keeps
 * working. So every deployment holding an application is stopped — through
 * `stopDeployment`, the same path as the console's button: the application is kept
 * (never deleted), the row stays as history, and the deployment's site key is
 * revoked.
 *
 * Best-effort by design. A Coolify outage must not make a suspension unsaveable —
 * the status change is the part with commercial meaning, the stop is logged loudly
 * and written onto the row, and the operator can press stop again.
 *
 * ## Reactivation restarts nothing
 *
 * `suspended → active` restores the site's *eligibility* to be deployed. It does not
 * start the old applications or queue a redeploy: a production rollout is an explicit
 * decision, and a stale container resurrected by a billing event is not one.
 *
 * ## Domain and verification changes re-render the routing map
 *
 * The map keys on the primary domain, its verification and the verified aliases. A
 * live `edge`/`direct` deployment made for the previous primary domain is left as it
 * is — the routing table drops it, the new hostname falls through to the built-in
 * renderer, and `GET …/deployment` reports `needsRedeploy` until someone redeploys.
 */

const INACTIVE = new Set(['archived', 'suspended'])

type SiteShape = {
  activeDeployment?: unknown
  domain?: unknown
  domains?: unknown
  domainVerified?: unknown
  id?: unknown
  renderedBy?: unknown
  status?: unknown
}

const verifiedAliases = (site: SiteShape): string =>
  (Array.isArray(site.domains) ? site.domains : [])
    .filter((row) => (row as { verified?: unknown })?.verified === true)
    .map((row) => normalizeDomain(String((row as { hostname?: unknown })?.hostname ?? '')))
    .sort()
    .join(',')

export const siteDeploymentLifecycle: CollectionAfterChangeHook = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update' || !previousDoc) return doc

  const next = doc as SiteShape
  const previous = previousDoc as SiteShape
  const siteId = String(next.id)

  const becameInactive = previous.status === 'active' && INACTIVE.has(String(next.status ?? ''))

  if (becameInactive) {
    try {
      const { failed, stopped } = await stopSiteDeployments(
        req,
        siteId,
        next.status === 'archived' ? 'سایت بایگانی شد.' : 'سایت معلق شد.',
      )
      if (failed.length) {
        req.payload.logger.error({
          msg: `site ${siteId} ${String(next.status)}: could not stop deployments ${failed.join(', ')} — stop them from the deployment console`,
        })
      } else if (stopped.length) {
        req.payload.logger.info({ msg: `site ${siteId} ${String(next.status)}: stopped ${stopped.length} deployment(s)` })
      }
    } catch (error) {
      req.payload.logger.error({
        err: error as Error,
        msg: `site ${siteId} ${String(next.status)}: stopping its deployments failed — stop them from the deployment console`,
      })
    }
  }

  const routingChanged =
    previous.status !== next.status ||
    normalizeDomain(String(previous.domain ?? '')) !== normalizeDomain(String(next.domain ?? '')) ||
    previous.domainVerified !== next.domainVerified ||
    verifiedAliases(previous) !== verifiedAliases(next) ||
    previous.renderedBy !== next.renderedBy

  if (routingChanged && (previous.renderedBy === 'deployment' || next.renderedBy === 'deployment')) {
    requestThemeRoutesRegeneration(req, `site ${siteId} lifecycle/domain change`)
  }

  if (!becameInactive) return doc

  /**
   * `stopDeployment` rewrote `renderedBy`/`activeDeployment` on this same document
   * after the outer update read it. Returning the fresh values keeps the admin form
   * that made the change from showing — and re-submitting — the stale ones.
   */
  const fresh = (await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: siteId,
    overrideAccess: true,
    req,
  })) as null | SiteShape

  return fresh
    ? {
        ...doc,
        activeDeployment: idOf(fresh.activeDeployment) ? next.activeDeployment : null,
        renderedBy: fresh.renderedBy,
      }
    : doc
}
