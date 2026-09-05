import type { TypedLocale } from 'payload'

import type { SitemapEntry } from '@/lib/sitemap'
import type { Site } from '@/payload-types'

import { alternateUrls } from '@/lib/alternates'
import { sitemapXml } from '@/lib/sitemap'
import { getSiteContext } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'
import { siteOrigin, siteUrl } from '@/lib/site-url'

/**
 * `https://acme.com/sitemap.xml` — one sitemap per customer domain, listing that
 * site's published pages in every locale it serves.
 *
 * A route handler rather than `next-sitemap` or Next's `sitemap.ts` convention:
 * both write the file at build time for a single origin, and the site list here is
 * database rows that change without a deploy. The `[domain]` segment comes from the
 * host rewrite in `src/proxy.ts`; the site itself is resolved from the `Host` header
 * by `getSiteContext`, exactly as a page render does.
 *
 * Posts are absent because they have no public route yet — a sitemap that lists URLs
 * returning 404 is worse than a short one. Add them here in the same change as the
 * route.
 */

/** Guard rail, not a limit anyone should hit: Google's own cap is 50,000 URLs. */
const MAX_URLS = 10_000

type SlugsById = Map<string, { lastmod?: null | string; slugs: Record<string, null | string> }>

/**
 * Every published page, keyed by document ID, with its slug per locale.
 *
 * One query per locale with `fallbackLocale: false`: with the fallback on, an
 * untranslated page reports the Persian slug for `en` and the sitemap would
 * advertise `/en/<persian-slug>`, which 404s.
 */
const publishedPages = async (site: Site): Promise<SlugsById> => {
  const served: string[] = site.availableLocales ?? []
  const byId: SlugsById = new Map()

  for (const locale of served) {
    const { docs } = await findForSite('pages', String(site.id), {
      depth: 0,
      fallbackLocale: false,
      limit: MAX_URLS,
      locale: locale as TypedLocale,
      pagination: false,
      select: { slug: true, updatedAt: true },
      sort: 'slug',
    })

    for (const doc of docs) {
      const { id, slug, updatedAt } = doc as {
        id: string
        slug?: null | string
        updatedAt?: string
      }

      if (!slug) continue

      const entry = byId.get(String(id)) ?? { lastmod: null, slugs: {} }

      entry.slugs[locale] = slug
      // The newest write in any locale: the document is one page, and a translation
      // updated today makes the whole document worth recrawling.
      if (updatedAt && (!entry.lastmod || updatedAt > entry.lastmod)) entry.lastmod = updatedAt

      byId.set(String(id), entry)
    }
  }

  return byId
}

export async function GET(request: Request): Promise<Response> {
  const { canonicalHost, site } = await getSiteContext()

  if (site && !canonicalHost) {
    return Response.redirect(`${siteOrigin(site)}/sitemap.xml${new URL(request.url).search}`, 308)
  }

  // Unknown, suspended or archived host. 404 rather than an empty sitemap: an empty
  // one is a claim that the site has no pages.
  if (!site) return new Response('Not found', { status: 404 })

  const pages = await publishedPages(site)

  const entries: SitemapEntry[] = []

  for (const { lastmod, slugs } of pages.values()) {
    const urls = alternateUrls(site, slugs)
    const alternates = Object.entries(urls)
      .filter(([hreflang]) => hreflang !== 'x-default')
      .map(([hreflang, href]) => ({ href, hreflang }))

    for (const [locale, slug] of Object.entries(slugs)) {
      if (!slug) continue

      entries.push({
        // Every locale gets its own `<url>`, each one listing the whole group —
        // reciprocal alternates are what makes a search engine trust them.
        alternates: alternates.length > 1 ? alternates : undefined,
        lastmod,
        loc: siteUrl(site, { locale, slug }),
      })
    }
  }

  return new Response(sitemapXml(entries), {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'Content-Type': 'application/xml; charset=utf-8',
    },
  })
}
