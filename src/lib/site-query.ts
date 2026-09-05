import type {
  CollectionSlug,
  Payload,
  PayloadRequest,
  DataFromCollectionSlug,
  PaginatedDocs,
  TypedLocale,
  TypedUser,
  Where,
} from 'payload'

import configPromise from '@payload-config'
import { getPayload } from 'payload'
import { cache } from 'react'

import type { Site } from '@/payload-types'

import { hostFromHeader, siteHostMatch } from './domains'

/**
 * The only module allowed to call the Local API from front-end code.
 *
 * The Local API skips access control by default, and every public page render is
 * a Local API call — so tenant scoping and draft hiding are NOT automatic. One
 * forgotten `overrideAccess: false` serves one customer's unpublished content on
 * another customer's domain. Both exports below close that hole; nothing outside
 * this file should call `payload.find` or `payload.findByID`.
 */

/** Deliberately narrow: `collection`, `overrideAccess` and tenant scoping are ours. */
type FindArgs = {
  depth?: number
  draft?: boolean
  /**
   * `false` turns Payload's locale fallback off for one read.
   *
   * `localization.fallback` is on globally, so an untranslated `slug` comes back
   * holding the Persian one — which reads as "this page exists in English" while
   * `where: { slug }` (which never falls back) 404s that very URL. Anything that
   * enumerates locales — hreflang, the sitemap — has to ask without the fallback or
   * it publishes URLs that do not resolve.
   */
  fallbackLocale?: false | TypedLocale
  limit?: number
  locale?: TypedLocale
  page?: number
  pagination?: boolean
  /** Narrows the columns Payload reads; the shape is Payload's `select` object. */
  select?: Record<string, unknown>
  sort?: string
  /** Needed for draft preview: `overrideAccess: false` has to see who is asking. */
  user?: TypedUser | null
  where?: Where
}

/** Cache tag for one site's slice of a collection. Shared by readers and revalidate hooks. */
export const siteTag = (siteId: string, ...parts: string[]): string =>
  ['site', siteId, ...parts].join(':')

/** The result of resolving an inbound hostname, including whether it was canonical. */
export type SiteHostResolution = {
  /** False for a verified alias; aliases redirect to this site's canonical `domain`. */
  canonical: boolean
  site: Site
}

/**
 * Host → site, whatever its lifecycle state. The one deliberate
 * `overrideAccess: true` in the codebase: an anonymous visitor must be able to
 * resolve the site they are asking for, and this lookup is what *establishes*
 * the tenant that everything else is scoped to, so it cannot itself be
 * tenant-scoped.
 *
 * A primary domain is still a unique column. Aliases live in `sites.domains`,
 * therefore both possible locations are queried, then the exact matching row is
 * inspected in memory. This final inspection matters: a broad SQL join must not
 * accidentally accept hostname A because a *different* alias row on the same site
 * happens to be verified.
 *
 * Lifecycle is deliberately *not* filtered here: a suspended or archived site
 * still owns its hostname, and `getSiteContext` needs to know it exists to serve
 * the holding page. Every *content* read goes through `findForSite` with an
 * active site — `serving: false` means no content, no chrome, holding page.
 */
const findSiteByHost = async (
  payload: Payload,
  host: null | string,
  req?: PayloadRequest,
): Promise<SiteHostResolution | null> => {
  const normalized = hostFromHeader(host)
  if (!normalized) return null

  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    // Both hostname columns are unique at the database layer, but use a small
    // cushion here so an old database with duplicate legacy alias rows cannot make
    // resolution depend on whichever row PostgreSQL returned first.
    limit: 10,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      or: [{ domain: { equals: normalized } }, { 'domains.hostname': { equals: normalized } }],
    },
  })

  for (const site of docs) {
    const match = siteHostMatch(site, normalized)
    if (match) return { canonical: match.canonical, site }
  }

  return null
}

/**
 * `cache` dedupes it per request — the layout and the page both need the site.
 */
export const getSiteHostResolution = cache(
  async (host: string | null): Promise<SiteHostResolution | null> =>
    findSiteByHost(await getPayload({ config: configPromise }), host),
)

/** Backwards-compatible convenience for callers that only need the tenant record. */
export const getSiteByHost = cache(
  async (host: string | null): Promise<Site | null> =>
    (await getSiteHostResolution(host))?.site ?? null,
)

/**
 * The same lookup for a Payload endpoint, which already holds a request and must not
 * reach for `next/headers` — `getSiteContext()` is a server-component API.
 *
 * This is how the checkout flow decides which site money is being paid to: from the
 * `Host` header, never from the request body. A tenant id a caller can choose is a
 * tenant id a caller can choose.
 */
export const siteFromRequest = async (req: PayloadRequest): Promise<Site | null> =>
  (await findSiteByHost(req.payload, req.headers?.get?.('host') ?? null, req))?.site ?? null

/**
 * Every front-end read. Always access-controlled, always scoped to one site.
 *
 * `overrideAccess: false` makes the collection's `read` access run, which returns
 * `{ _status: { equals: 'published' } }` for anonymous requests — necessary
 * because `draft: false` alone does not filter drafts out of a query.
 */
export const findForSite = async <T extends CollectionSlug>(
  collection: T,
  siteId: string,
  { where, ...args }: FindArgs,
): Promise<PaginatedDocs<DataFromCollectionSlug<T>>> => {
  const payload = await getPayload({ config: configPromise })

  // `payload.find`'s options are a union over every collection slug; resolving it
  // against a generic slug exceeds TS's union limit (TS2590). The cast is only
  // about that limit — the public signature above stays fully typed.
  const result = await (payload.find as (args: unknown) => Promise<PaginatedDocs<unknown>>)({
    ...args,
    collection,
    overrideAccess: false,
    where: {
      and: [{ site: { equals: siteId } }, ...(where ? [where] : [])],
    },
  })

  return result as PaginatedDocs<DataFromCollectionSlug<T>>
}

/**
 * Per-site singleton (`isGlobal: true` in the plugin) — one document per site.
 * Returns null before the site's editor has saved one.
 */
export const findGlobalForSite = async <T extends CollectionSlug>(
  collection: T,
  siteId: string,
  args: FindArgs,
): Promise<DataFromCollectionSlug<T> | null> => {
  const { docs } = await findForSite(collection, siteId, { ...args, limit: 1, pagination: false })

  return docs[0] ?? null
}
