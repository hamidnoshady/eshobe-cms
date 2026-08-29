import type { TypedLocale } from 'payload'

import { cache } from 'react'

import type { Site } from '@/payload-types'

import { findForSite } from './site-query'
import { siteUrl } from './site-url'

/**
 * The set of URLs one document has across the locales its site serves — the input
 * to both `hreflang` tags and the sitemap's `<xhtml:link>` alternates.
 *
 * Two rules decide what belongs in that set, and both come from how this platform
 * stores content:
 *
 * 1. **Only locales the site serves.** Locales are a platform-wide menu
 *    (`lib/locales`); each site offers a subset. Advertising `en` for a Persian-only
 *    site points search engines at a URL the route resolver 404s.
 * 2. **Only locales the document is actually translated into.** `slug` is localized
 *    and locale fallback is on, so an untranslated page still reports a slug — the
 *    Persian one. Following that link with an `/en` prefix 404s (the slug lookup
 *    itself does not fall back), so a page is only listed for a locale that has its
 *    own slug row.
 */
type AlternatesSite = Pick<Site, 'availableLocales' | 'defaultLocale' | 'domain'>

/** `{ fa: 'https://acme.com/about', en: 'https://acme.com/en/about', 'x-default': … }` */
export const alternateUrls = (
  site: AlternatesSite,
  slugByLocale: Record<string, null | string | undefined>,
): Record<string, string> => {
  const served: string[] = site.availableLocales ?? []

  const entries = served
    .filter((locale) => typeof slugByLocale[locale] === 'string' && slugByLocale[locale])
    .map((locale): [string, string] => [
      locale,
      siteUrl(site, { locale, slug: slugByLocale[locale] }),
    ])

  if (!entries.length) return {}

  /**
   * `x-default` is the URL to send a visitor to when none of the declared locales
   * matches theirs — the site's own default locale, falling back to whichever
   * translation exists when the default one does not.
   */
  const fallback = entries.find(([locale]) => locale === site.defaultLocale) ?? entries[0]!

  return Object.fromEntries([...entries, ['x-default', fallback[1]]])
}

/**
 * One document's slug in every locale the site serves, `null` where untranslated.
 *
 * One query per locale, by ID: a locale-less read is not possible in Payload, and
 * `fallbackLocale: false` is what makes "untranslated" distinguishable from
 * "translated to the same string". Sites serve two locales in practice, and `cache`
 * dedupes the call between `generateMetadata` and the page body.
 */
export const localeSlugs = cache(
  async (
    collection: 'pages' | 'posts',
    site: Site,
    id: number | string,
  ): Promise<Record<string, null | string>> => {
    const served: string[] = site.availableLocales ?? []

    const results = await Promise.all(
      served.map(async (locale) => {
        const { docs } = await findForSite(collection, String(site.id), {
          depth: 0,
          fallbackLocale: false,
          limit: 1,
          locale: locale as TypedLocale,
          pagination: false,
          select: { slug: true },
          where: { id: { equals: id } },
        })

        const slug = (docs[0] as { slug?: null | string } | undefined)?.slug

        return [locale, slug ?? null] as const
      }),
    )

    return Object.fromEntries(results)
  },
)
