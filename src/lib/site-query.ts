import type {
  CollectionSlug,
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
  limit?: number
  locale?: TypedLocale
  page?: number
  pagination?: boolean
  sort?: string
  /** Needed for draft preview: `overrideAccess: false` has to see who is asking. */
  user?: TypedUser | null
  where?: Where
}

/** Cache tag for one site's slice of a collection. Shared by readers and revalidate hooks. */
export const siteTag = (siteId: string, ...parts: string[]): string =>
  ['site', siteId, ...parts].join(':')

/** A `Host` header may carry a port; `sites.domain` never does. */
const normalizeHost = (host: string): string => host.split(':')[0]!.toLowerCase()

/**
 * Host → site, whatever its lifecycle state. The one deliberate
 * `overrideAccess: true` in the codebase: an anonymous visitor must be able to
 * resolve the site they are asking for, and this lookup is what *establishes*
 * the tenant that everything else is scoped to, so it cannot itself be
 * tenant-scoped.
 *
 * Lifecycle is deliberately *not* filtered here: a suspended or archived site
 * still owns its domain, and `getSiteContext` needs to know it exists to serve
 * the holding page. Every *content* read goes through `findForSite` with an
 * active site — `serving: false` means no content, no chrome, holding page.
 *
 * `cache` dedupes it per request — the layout and the page both need the site.
 */
export const getSiteByHost = cache(async (host: string | null): Promise<Site | null> => {
  if (!host) return null

  const payload = await getPayload({ config: configPromise })

  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { domain: { equals: normalizeHost(host) } },
  })

  return docs[0] ?? null
})

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
