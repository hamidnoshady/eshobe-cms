import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, PayloadRequest } from 'payload'

import { revalidatePath, revalidateTag } from 'next/cache'

import { tryRevalidate } from '@/hooks/revalidate'
import { archiveSlugOf, DEFAULT_PERMALINK_TEMPLATE } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'
import { defaultLocale } from '@/lib/locales'
import { siteTag } from '@/lib/site-cache'
import { revalidationPaths } from '@/lib/site-url'

/**
 * Cache invalidation for `content-entries` (issue #166) — the
 * `revalidateSiteDoc` rules (`/{domain}/{locale}/{…}`, default locale busted
 * twice) with two differences the engine forces: publication lives in
 * `status`, not `_status`, and the route base is each type's archive slug, so
 * it is read from the entry's definition instead of being a constant.
 */

type EntryRouting = {
  contentType?: unknown
  id?: unknown
  site?: unknown
  slug?: null | string
  status?: null | string
}

const routingBase = async (
  doc: EntryRouting,
  req: PayloadRequest,
): Promise<{ base: string; slug?: null | string }> => {
  const typeId = idOf(doc.contentType)
  const fallback = { base: '', slug: doc.slug }

  if (!typeId) return fallback

  const typeDef = await req.payload
    .find({
      collection: 'content-type-definitions',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      select: { archiveSlug: true, key: true, permalinkTemplate: true },
      where: { id: { equals: typeId } },
    })
    .then(({ docs }) => docs[0])
    .catch(() => undefined)

  if (!typeDef) return fallback

  const template = (typeDef as { permalinkTemplate?: null | string }).permalinkTemplate ??
    DEFAULT_PERMALINK_TEMPLATE
  const base = template.startsWith('/{archive}/')
    ? `/${archiveSlugOf(typeDef as { archiveSlug?: null | string; key: string })}`
    : ''
  const slug = template.endsWith('{id}') ? String(doc.id ?? '') : doc.slug

  return { base, slug }
}

const revalidate = async (doc: EntryRouting, req: PayloadRequest): Promise<void> => {
  const siteId = idOf(doc.site)
  if (siteId) {
    const tag = siteTag(siteId, 'content-entries')
    tryRevalidate(req.payload, tag, () => revalidateTag(tag, 'max'))
  }

  if (!siteId) return

  const site = await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: siteId,
    req,
    select: { defaultLocale: true, domain: true },
  })

  if (!site?.domain) return

  const { base, slug } = await routingBase(doc, req)
  const locale = String(req.locale ?? defaultLocale)

  // The entry's own URL, and its archive listing (the listing's contents just
  // changed even when only this entry did).
  const paths = [
    ...revalidationPaths({
      base,
      domain: site.domain,
      locale,
      siteDefaultLocale: site.defaultLocale ?? null,
      slug,
    }),
    ...(base
      ? revalidationPaths({
          base,
          domain: site.domain,
          locale,
          siteDefaultLocale: site.defaultLocale ?? null,
        })
      : []),
  ]

  for (const path of paths) {
    req.payload.logger.info(`Revalidating ${path}`)
    tryRevalidate(req.payload, path, () => revalidatePath(path))
  }
}

export const revalidateContentEntry: CollectionAfterChangeHook = async ({
  doc,
  previousDoc,
  req,
}) => {
  if (req.context.disableRevalidate) return doc

  const entry = doc as EntryRouting
  const previous = previousDoc as EntryRouting | undefined

  if (entry.status === 'published') await revalidate(entry, req)

  // Unpublish, trash, or slug change: the old URL must stop answering.
  if (
    previous?.status === 'published' &&
    (entry.status !== 'published' || previous.slug !== entry.slug)
  ) {
    await revalidate(previous, req)
  }

  return doc
}

export const revalidateContentEntryDelete: CollectionAfterDeleteHook = async ({ doc, req }) => {
  if (!req.context.disableRevalidate && doc) await revalidate(doc as EntryRouting, req)

  return doc
}
