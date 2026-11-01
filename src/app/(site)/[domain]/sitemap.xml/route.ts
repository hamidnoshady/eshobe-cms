import type { TypedLocale } from 'payload'

import type { SitemapEntry } from '@/lib/sitemap'
import type { Site } from '@/payload-types'

import { alternateUrls } from '@/lib/alternates'
import { archivePathOf, entryPath } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'
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
 * Pages come first, then the site's custom content (issue #166 §3):
 * published `content-entries` under their type's permalink template, and the
 * archive listing of every type that has one. Term archives are deliberately
 * absent for now — their URLs resolve, but listing them well needs per-term
 * entry counts so empty archives stay out. (Posts likewise wait for their own
 * sitemap change; a sitemap that lists URLs returning 404 is worse than a
 * short one.)
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
      cachePublic: true,
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


type PathsById = Map<string, { lastmod?: null | string; paths: Record<string, null | string> }>

/**
 * Every published custom entry (and every type archive), keyed by document
 * ID, with its full site-relative path per locale.
 *
 * The same per-locale, `fallbackLocale: false` discipline as pages: an
 * entry's slug *and* its type's archive base are both localized, so a locale
 * only earns a URL when both rows exist in it. Anonymous reads already see
 * published entries only (the collection's read access); `noindex` entries
 * are filtered here, because a sitemap is an invitation to index.
 */
const publishedContent = async (site: Site): Promise<PathsById> => {
  const served: string[] = site.availableLocales ?? []
  const byId: PathsById = new Map()

  const record = (key: string, locale: string, path: null | string, updatedAt?: string) => {
    if (!path) return

    const entry = byId.get(key) ?? { lastmod: null, paths: {} }

    entry.paths[locale] = path
    if (updatedAt && (!entry.lastmod || updatedAt > entry.lastmod)) entry.lastmod = updatedAt

    byId.set(key, entry)
  }

  const typeSelect = {
    archiveSlug: true,
    hasArchive: true,
    key: true,
    permalinkTemplate: true,
    updatedAt: true,
  }

  // Request-time matching reads definitions with locale fallback ON, so a
  // type whose `archiveSlug` exists only in the default locale answers under
  // that base in *every* locale — and under its machine key when it has no
  // archive slug at all. The sitemap must spell the same base or it invents
  // URLs that 404 (`/en/<key>` for a Persian-named archive).
  const { docs: defaultTypes } = await findForSite('content-type-definitions', String(site.id), {
    cachePublic: true,
    depth: 0,
    fallbackLocale: false,
    limit: MAX_URLS,
    locale: site.defaultLocale as TypedLocale,
    pagination: false,
    select: typeSelect,
  })
  const defaultBaseById = new Map(
    defaultTypes.map((type) => [String(type.id), type.archiveSlug?.trim() || type.key]),
  )

  for (const locale of served) {
    const shared = {
      cachePublic: true,
      depth: 0,
      fallbackLocale: false as const,
      limit: MAX_URLS,
      locale: locale as TypedLocale,
      pagination: false,
    }

    const { docs: rawTypes } = await findForSite('content-type-definitions', String(site.id), {
      ...shared,
      select: typeSelect,
    })
    // The effective routing base in this locale, per the fallback rule above.
    const types = rawTypes.map((type) => ({
      ...type,
      archiveSlug: type.archiveSlug ?? defaultBaseById.get(String(type.id)) ?? null,
    }))
    const typeById = new Map(types.map((type) => [String(type.id), type]))

    for (const type of types) {
      const templated = (type.permalinkTemplate ?? '').startsWith('/{archive}/')

      if (type.hasArchive !== false && templated) {
        record(`archive:${type.id}`, locale, archivePathOf(type), type.updatedAt)
      }
    }

    const { docs: entries } = await findForSite('content-entries', String(site.id), {
      ...shared,
      select: { contentType: true, noindex: true, slug: true, updatedAt: true },
      where: { status: { equals: 'published' } },
    })

    for (const entry of entries) {
      if (entry.noindex) continue

      const type = typeById.get(idOf(entry.contentType) ?? '')

      if (!type || !entry.slug) continue

      record(
        `entry:${entry.id}`,
        locale,
        entryPath(type, { id: String(entry.id), slug: entry.slug }),
        entry.updatedAt,
      )
    }
  }

  return byId
}

/**
 * `alternateUrls` for paths rather than slugs: an entry's URL base is
 * localized data, so the per-locale path is computed first and only the
 * locale prefixing + `x-default` rule is shared in spirit.
 */
const pathAlternates = (
  site: Site,
  paths: Record<string, null | string>,
): { href: string; hreflang: string }[] =>
  Object.entries(paths)
    .filter(([, path]) => Boolean(path))
    .map(([locale, path]) => ({
      href: siteUrl(site, { base: path!, locale }),
      hreflang: locale,
    }))

export async function GET(request: Request): Promise<Response> {
  const { canonicalHost, site } = await getSiteContext()

  if (site && !canonicalHost) {
    return Response.redirect(`${siteOrigin(site)}/sitemap.xml${new URL(request.url).search}`, 308)
  }

  // Unknown, suspended or archived host. 404 rather than an empty sitemap: an empty
  // one is a claim that the site has no pages.
  if (!site) return new Response('Not found', { status: 404 })

  const pages = await publishedPages(site)
  const content = await publishedContent(site)

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

  for (const { lastmod, paths } of content.values()) {
    const alternates = pathAlternates(site, paths)

    for (const { href } of alternates) {
      entries.push({
        alternates: alternates.length > 1 ? alternates : undefined,
        lastmod,
        loc: href,
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
