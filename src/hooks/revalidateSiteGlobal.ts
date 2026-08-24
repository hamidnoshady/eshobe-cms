import type { CollectionAfterChangeHook } from 'payload'

import { revalidateTag } from 'next/cache'

import { siteTag } from '@/lib/site-query'

/**
 * Bust one site's copy of a per-site singleton (header, footer, theme).
 *
 * The tag carries the site id: a platform-wide `header` tag would flush every
 * customer's cache whenever one of them edits their nav, and — worse — makes it
 * impossible to tell whose copy is actually stale.
 */
export const revalidateSiteGlobal =
  (collection: string): CollectionAfterChangeHook =>
  ({ doc, req: { context, payload } }) => {
    if (context.disableRevalidate) return doc

    // The tenant field is populated to a full document at depth > 0.
    const site = (doc as { site?: string | { id?: string } }).site
    const siteId = typeof site === 'object' ? site?.id : site

    if (!siteId) {
      // Means the collection is missing from the plugin's `collections` map, or a
      // script wrote it without a tenant. Both leave the page permanently stale,
      // so it is logged rather than swallowed.
      payload.logger.warn(`${collection}: document has no site, skipping revalidation`)

      return doc
    }

    const tag = siteTag(siteId, collection)

    payload.logger.info(`Revalidating ${tag}`)

    revalidateTag(tag, 'max')

    return doc
  }
