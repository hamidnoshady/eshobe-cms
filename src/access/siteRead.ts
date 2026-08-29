import type { Access, PayloadRequest } from 'payload'

import { idOf } from '@/lib/ids'
import { siteFromRequest } from '@/lib/site-query'

/**
 * Public reads, scoped to the tenant the request arrived on.
 *
 * ## Why access control and not the query layer
 *
 * `findForSite()` (`src/lib/site-query.ts`) has always been the render path's
 * guarantee, and `CLAUDE.md`'s rule is stated as "never call `payload.find` in
 * front-end code". That holds for this app. It does not hold for **the REST and
 * GraphQL APIs**: the plugin ANDs its tenant constraint only for a logged-in member
 * of the admin users collection, so an anonymous `GET /api/pages` — or a headless
 * site builder consuming the API from a customer's domain — gets every customer's
 * published rows unless *it* remembers to filter. Security that depends on the client
 * remembering is not security, and the moment the CMS serves a second renderer it is
 * the whole surface.
 *
 * So the scope is applied here instead: derived from the `Host` the request came in
 * on, ANDed into whatever the collection's own read access returns. A client's `where`
 * can **narrow** the result (a category filter, a slug, a search) and can never widen
 * it — a `where[site][equals]=<other site>` now intersects with the host's site and
 * yields nothing.
 *
 * ## The part this does not cover — deliberately
 *
 * When the host resolves to no site, nothing is added. That is the control plane
 * (`admin.example.com`, and `localhost` in dev) *and* every non-request context: the
 * CLI seed, jobs tasks, `payload.update` from a hook, and tests built with
 * `createLocalReq`. Failing closed there would mean a seeded script or a reindex task
 * has to fabricate a `Host` header to read the tenant it owns, which trades a real
 * leak for an unfathomable one. The follow-ups that close it — deny anonymous
 * `/api/*` reads on the control plane at the proxy, per-site read keys — are scoped in
 * `WAVE-9.md`, and they are proxy/config work, not more hooks.
 */

const SITE_CONTEXT_KEY = 'eshobeRequestSiteId'

/**
 * One `Host` → site lookup per request, shared by every collection's access function
 * on that request. `null` is memoized as `''` because `undefined` means "not looked
 * up yet" in a `RequestContext`.
 */
export const requestSiteId = async (req: PayloadRequest): Promise<null | string> => {
  const cached = req.context[SITE_CONTEXT_KEY] as string | undefined

  if (typeof cached === 'string') return cached || null

  // No `Host` at all means a Local API call from a script, a job task or a hook —
  // there is no request to attribute, so there is nothing to scope. Checked before the
  // lookup rather than inside it so those contexts never touch the database twice.
  if (typeof req.headers?.get !== 'function') return null

  const site = await siteFromRequest(req)
  const siteId = site ? idOf(site.id) ?? '' : ''

  req.context[SITE_CONTEXT_KEY] = siteId

  return siteId || null
}

/**
 * The tenant clause, or `null` when there is no tenant to scope to.
 *
 * A single field constraint rather than an `and` wrapper: the callers below compose it
 * with whatever the collection's own access returned, and Payload ANDs that with the
 * multi-tenant plugin's constraint in turn — nesting `and` inside `and` for no reason
 * makes a leaked query much harder to read when one is being debugged.
 */
const siteConstraint = async (req: PayloadRequest): Promise<null | { site: { equals: string } }> => {
  const siteId = await requestSiteId(req)

  // No tenant to scope to — see "The part this does not cover".
  if (!siteId) return null

  return { site: { equals: siteId } }
}

/**
 * For public collections **without** drafts (media, categories, the per-site
 * singletons): the tenant, or whatever the collection already allowed.
 */
export const scopedPublicRead =
  (base: Access = () => true): Access =>
  async (args) => {
    const allowed = await base(args)
    const site = await siteConstraint(args.req)

    if (allowed === false || !site) return allowed
    if (allowed === true) return site

    return { and: [allowed, site] }
  }

/**
 * For public collections with drafts: the tenant AND `_status: published`, which is
 * the shape `CLAUDE.md` requires of a public read (a boolean would leak drafts, and
 * `draft: false` on a read does not filter them).
 *
 * Logged-in users get `base` untouched: the admin must be able to see drafts, and the
 * multi-tenant plugin already narrows staff to their own sites.
 */
export const scopedPublishedRead =
  (base: Access): Access =>
  async (args) => {
    if (args.req.user) return base(args)

    const allowed = await base(args)
    const site = await siteConstraint(args.req)

    if (allowed === false || !site) return allowed

    // A collection whose own read says "everything" still must not hand a draft to an
    // anonymous caller: `draft: false` on a query does not filter drafts, only this
    // clause does.
    if (allowed === true) return { and: [{ _status: { equals: 'published' } }, site] }

    return { and: [allowed, site] }
  }
