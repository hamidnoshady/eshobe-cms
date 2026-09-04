import type { Access, PayloadRequest } from 'payload'

import { idOf } from '@/lib/ids'
import { siteFromRequest } from '@/lib/site-query'

import { requestApiKey } from './siteApiKey'

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
 * ## When the host resolves to no site
 *
 * Two very different callers land here, and they are told apart by whether there is
 * an HTTP request at all:
 *
 *   - **A non-request context** — the CLI seed, a jobs task, `payload.update` from a
 *     hook, `findForSite` itself (which passes no `req` at all, so Payload
 *     synthesizes one). There is no `Host` to attribute, so nothing is added and the
 *     collection's own access decides. Failing closed here would mean a seeded
 *     script, a reindex task or the app's own render path has to fabricate a `Host`
 *     header to read the tenant it already named.
 *
 *   - **An anonymous HTTP caller on a host that is not a customer site** — the
 *     control plane (`admin.example.com`, and `localhost` in dev), or an unknown
 *     domain. This used to fall through to the collection's own access, which for
 *     every public collection is "any published row" — so an unauthenticated
 *     `GET https://admin.example.com/api/pages` returned *every customer's*
 *     published pages, and `/api/products`, `/api/media`, `/api/categories`,
 *     `/api/store`, `/api/theme` and `/api/graphql` did the same for their
 *     collections. The mitigation was scoped as proxy work in `WAVE-9.md` and never
 *     shipped, which left the platform's whole content surface enumerable by anyone
 *     who knew the admin hostname. It is closed here instead: no tenant, no session
 *     and no API key means no rows.
 *
 * An admin session (`req.user`) and an API key are both untouched by that rule —
 * the multi-tenant plugin narrows the former to its own sites, and `apiKeyAware`
 * resolves the latter to the one site its key names before this ever runs.
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

  // No tenant to scope to — see "When the host resolves to no site".
  if (!siteId) return null

  return { site: { equals: siteId } }
}

/**
 * An anonymous HTTP caller whose `Host` names no site — the control plane, or a
 * domain no customer owns. Such a request has no tenant it could legitimately be
 * asking about, so the answer is no rows rather than every tenant's rows.
 *
 * Deliberately narrow, because each excluded case is a caller that *does* have a
 * tenant by some other means:
 *
 *   - no `headers.get` at all — a Local API call (seed, job, hook, test), which has
 *     no request to attribute and must not have to fabricate one;
 *   - `req.user` — an admin session, which the multi-tenant plugin already narrows
 *     to the sites that user belongs to;
 *   - an API key — `apiKeyAware` scopes it to the single site the key names, and a
 *     collection that is not wrapped in `apiKeyAware` (media, categories, theme,
 *     store) must still answer that site's own headless client.
 */
const isUnscopedAnonymousRequest = async (req: PayloadRequest): Promise<boolean> => {
  // The discriminator is a `Host` header, not the presence of a `headers` object:
  // `payload.find` with no `req` — which is how `findForSite` and every seed, job
  // and hook call it — gets a synthesized req carrying empty `Headers`, so
  // `headers.get` exists and answers null. Keying on the function would deny the
  // app's own render path. Every real HTTP request carries a Host (HTTP/1.1
  // requires it, HTTP/2 carries `:authority`), so nothing reachable from outside
  // lands in the exempt branch.
  if (!req.headers?.get?.('host')) return false
  if (req.user) return false
  if (await requestApiKey(req)) return false

  return (await requestSiteId(req)) === null
}

/**
 * For public collections **without** drafts (media, categories, the per-site
 * singletons): the tenant, or whatever the collection already allowed.
 */
export const scopedPublicRead =
  (base: Access = () => true): Access =>
  async (args) => {
    if (await isUnscopedAnonymousRequest(args.req)) return false

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
    if (await isUnscopedAnonymousRequest(args.req)) return false

    const allowed = await base(args)
    const site = await siteConstraint(args.req)

    if (allowed === false || !site) return allowed

    // A collection whose own read says "everything" still must not hand a draft to an
    // anonymous caller: `draft: false` on a query does not filter drafts, only this
    // clause does.
    if (allowed === true) return { and: [{ _status: { equals: 'published' } }, site] }

    return { and: [allowed, site] }
  }
