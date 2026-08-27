import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, PayloadRequest } from 'payload'

import { revalidatePath } from 'next/cache'

import type { Page } from '../../../payload-types'

import { tryRevalidate } from '@/hooks/revalidate'
import { defaultLocale } from '@/lib/locales'
import { HOME_SLUG } from '@/lib/slug'

/**
 * Rendered paths are `/{domain}/{locale}/{slug}` — the domain is a real route
 * segment, written by middleware from the `Host` header. Revalidating `/{slug}`
 * (what the template did) busts a path that does not exist on any site.
 *
 * The default locale has two valid URLs: `/{domain}/{slug}` and
 * `/{domain}/{locale}/{slug}`. Middleware cannot collapse them — resolving a site's
 * default locale needs the database, which the edge runtime has no access to — so
 * both get busted.
 */
const pathsFor = (domain: string, locale: string, defaultLocale: string, slug?: string | null) => {
  const tail = slug && slug !== HOME_SLUG ? `/${slug}` : ''
  const paths = [`/${domain}/${locale}${tail}`]

  if (locale === defaultLocale) paths.push(`/${domain}${tail}`)

  return paths
}

/** `site` is an id on a shallow read and a document on a populated one. */
const domainOf = async (site: Page['site'], req: PayloadRequest): Promise<string | null> => {
  if (site && typeof site === 'object') return site.domain ?? null

  if (!site) return null

  const doc = await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: String(site),
    req,
  })

  return doc?.domain ?? null
}

const revalidate = async (doc: Page, req: PayloadRequest, slug?: string | null): Promise<void> => {
  const domain = await domainOf(doc.site, req)
  if (!domain) return

  const locale = String(req.locale ?? defaultLocale)

  for (const path of pathsFor(domain, locale, defaultLocale, slug)) {
    req.payload.logger.info(`Revalidating ${path}`)
    // Guarded: a scheduled publish runs this from the jobs queue, where there is no
    // request context for `revalidatePath` to find — see `tryRevalidate`.
    tryRevalidate(req.payload, path, () => revalidatePath(path))
  }
}

export const revalidatePage: CollectionAfterChangeHook<Page> = async ({
  doc,
  previousDoc,
  req,
}) => {
  if (req.context.disableRevalidate) return doc

  if (doc._status === 'published') await revalidate(doc, req, doc.slug)

  // Unpublishing, or a slug change, leaves the old URL cached.
  if (previousDoc?._status === 'published' && previousDoc.slug !== doc.slug) {
    await revalidate(doc, req, previousDoc.slug)
  }

  if (previousDoc?._status === 'published' && doc._status !== 'published') {
    await revalidate(doc, req, previousDoc.slug)
  }

  return doc
}

export const revalidateDelete: CollectionAfterDeleteHook<Page> = async ({ doc, req }) => {
  if (!req.context.disableRevalidate) await revalidate(doc, req, doc?.slug)

  return doc
}
