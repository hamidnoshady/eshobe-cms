import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  PayloadRequest,
} from 'payload'

import { revalidatePath } from 'next/cache'

import { tryRevalidate } from '@/hooks/revalidate'
import { defaultLocale } from '@/lib/locales'
import { notifyRenderers } from '@/lib/renderer-webhook'
import { revalidationPaths } from '@/lib/site-url'

/**
 * Live-preview/revalidation for anything rendered under `[domain]` — pages and posts
 * today, whatever else gets a route tomorrow.
 *
 * One implementation because the two rules that matter are easy to get subtly wrong
 * per-collection: the path shape is `/{domain}/{locale}/{slug}` (the template's
 * `revalidatePath('/' + slug)` busts a path that exists on no site), and the site's
 * default locale answers to *two* URLs, so both get busted. `revalidationPaths()` owns
 * that; this file owns the *when*.
 *
 * `base` is the collection's route prefix — `''` for pages, `POSTS_BASE` for posts —
 * so a post at `hello-world` busts `/posts/hello-world`, not `/hello-world`.
 */
type DocWithRouting = {
  _status?: null | string
  site?: null | string | { domain?: string | null; id?: string }
  slug?: null | string
}

/**
 * The two things about a site that decide which URLs to bust. `site` is an id on a
 * shallow write and a document on a populated read, so both shapes are accepted; and
 * the *site's* default locale is what makes `/{domain}/{slug}` canonical, not the
 * platform's — a site whose default is `en` has `/en` aliased to no prefix, not `/fa`.
 */
const routingFor = async (
  site: DocWithRouting['site'],
  req: PayloadRequest,
): Promise<{ domain: null | string; siteDefaultLocale: null | string }> => {
  if (site && typeof site === 'object') {
    return {
      domain: site.domain ?? null,
      siteDefaultLocale: (site as { defaultLocale?: null | string }).defaultLocale ?? null,
    }
  }

  if (!site) return { domain: null, siteDefaultLocale: null }

  const doc = await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: String(site),
    req,
    select: { defaultLocale: true, domain: true },
  })

  return { domain: doc?.domain ?? null, siteDefaultLocale: doc?.defaultLocale ?? null }
}

const revalidate = async (
  doc: DocWithRouting,
  req: PayloadRequest,
  base: string,
  slug?: null | string,
): Promise<void> => {
  const { domain, siteDefaultLocale } = await routingFor(doc.site, req)

  if (!domain) return

  const locale = String(req.locale ?? defaultLocale)

  const paths = revalidationPaths({ base, domain, locale, siteDefaultLocale, slug })

  for (const path of paths) {
    req.payload.logger.info(`Revalidating ${path}`)

    tryRevalidate(req.payload, path, () => revalidatePath(path))
  }

  // The other half of the same event: this app's cache is not the only one holding the
  // document. Best-effort and env-gated, so a platform without an external renderer
  // never makes a request.
  const siteId = doc.site && typeof doc.site === 'object' ? doc.site.id : doc.site

  if (siteId) notifyRenderers({ paths, req, siteId: String(siteId) })
}

export const revalidateSiteDoc =
  (base = ''): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, req }) => {
    // Seeding and CLI scripts run outside a Next request, where `revalidatePath`
    // throws `static generation store missing`.
    if (req.context.disableRevalidate) return doc

    if (doc._status === 'published') await revalidate(doc as DocWithRouting, req, base, doc.slug)

    // Unpublishing, or a slug change, leaves the old URL cached.
    if (previousDoc?._status === 'published' && previousDoc.slug !== doc.slug) {
      await revalidate(doc as DocWithRouting, req, base, previousDoc.slug)
    }

    if (previousDoc?._status === 'published' && doc._status !== 'published') {
      await revalidate(doc as DocWithRouting, req, base, previousDoc?.slug)
    }

    return doc
  }

export const revalidateSiteDocDelete =
  (base = ''): CollectionAfterDeleteHook =>
  async ({ doc, req }) => {
    if (!req.context.disableRevalidate && doc) {
      await revalidate(doc as DocWithRouting, req, base, doc?.slug)
    }

    return doc
  }
