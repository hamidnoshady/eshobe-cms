import type { CollectionAfterChangeHook, CollectionAfterDeleteHook } from 'payload'

import { revalidateTag } from 'next/cache'

import { tryRevalidate } from '@/hooks/revalidate'
import { notifyRenderers } from '@/lib/renderer-webhook'

/**
 * Bust one site's copy of a per-site singleton (header, footer, theme).
 *
 * The tag carries the site id: a platform-wide `header` tag would flush every
 * customer's cache whenever one of them edits their nav, and — worse — makes it
 * impossible to tell whose copy is actually stale.
 */
const revalidateGlobalForSite = ({
  collection,
  payload,
  req,
  siteId,
}: {
  collection: string
  payload: Parameters<CollectionAfterChangeHook>[0]['req']['payload']
  req: Parameters<CollectionAfterChangeHook>[0]['req']
  siteId: string
}) => {
  const tag = ['site', siteId, collection].join(':')

  payload.logger.info(`Revalidating ${tag}`)

  tryRevalidate(payload, tag, () => revalidateTag(tag, 'max'))
  notifyRenderers({ paths: ['/'], req, resources: [collection], siteId, tags: [tag] })
}

const siteIdFromDoc = (doc: { site?: string | { id?: string } } | null | undefined) => {
  const site = doc?.site
  return typeof site === 'object' ? site?.id : site
}

export const revalidateSiteGlobal =
  (collection: string): CollectionAfterChangeHook =>
  ({ doc, req }) => {
    const { context, payload } = req
    if (context.disableRevalidate) return doc

    const siteId = siteIdFromDoc(doc as { site?: string | { id?: string } })

    if (!siteId) {
      // Means the collection is missing from the plugin's `collections` map, or a
      // script wrote it without a tenant. Both leave the page permanently stale,
      // so it is logged rather than swallowed.
      payload.logger.warn(`${collection}: document has no site, skipping revalidation`)

      return doc
    }

    revalidateGlobalForSite({ collection, payload, req, siteId: String(siteId) })

    return doc
  }

export const revalidateSiteGlobalDelete =
  (collection: string): CollectionAfterDeleteHook =>
  ({ doc, req }) => {
    if (req.context.disableRevalidate || !doc) return doc

    const siteId = siteIdFromDoc(doc as { site?: string | { id?: string } })
    if (!siteId) {
      req.payload.logger.warn(`${collection}: deleted document has no site, skipping revalidation`)
      return doc
    }

    revalidateGlobalForSite({
      collection,
      payload: req.payload,
      req,
      siteId: String(siteId),
    })

    return doc
  }
