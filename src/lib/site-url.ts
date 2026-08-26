import type { PayloadRequest } from 'payload'

import type { Site } from '@/payload-types'

import { localeHref } from './locales'
import { pagePath } from './slug'
import { getServerSideURL } from '@/utilities/getURL'

/**
 * Where a document actually lives on the public web.
 *
 * Three places need this and each used to guess: the live-preview button, the SEO
 * plugin's URL preview, and the page's canonical/OG tags. All three built
 * `${getServerSideURL()}/${slug}` — the *admin's* origin, no locale segment, and
 * `/home` for the front page. On a platform where every site has its own domain,
 * that URL belongs to nobody.
 */

/** Only the two fields that decide a URL, so callers can pass a partial site. */
type UrlSite = Pick<Site, 'defaultLocale' | 'domain'>

/**
 * Site-relative path in one locale. The site's default locale has no segment, so
 * `/about` and `/fa/about` are not two URLs for one page — see `localeHref`.
 */
export const sitePath = (site: UrlSite, locale?: string | null, slug?: string | null): string =>
  localeHref(pagePath(slug), locale ?? site.defaultLocale, site.defaultLocale)

/**
 * `http://acme.localhost:3000` in dev, `https://acme.com` in production. Protocol
 * and port come from the deployment we are already serving — dev puts every domain
 * on one port, production on none, and hardcoding either breaks the other.
 */
export const siteOrigin = (site: UrlSite, origin?: string | null): string => {
  const { port, protocol } = new URL(origin || getServerSideURL())

  return `${protocol}//${site.domain}${port ? `:${port}` : ''}`
}

export const siteUrl = (
  site: UrlSite,
  { locale, origin, slug }: { locale?: string | null; origin?: string | null; slug?: string | null },
): string => siteOrigin(site, origin) + sitePath(site, locale, slug)

/**
 * The same, for admin-side hooks that hold a document rather than a resolved site.
 * Returns null when the document has no site or no slug yet: a preview button that
 * goes nowhere beats one that opens another customer's domain.
 */
export const siteUrlForDoc = async ({
  doc,
  locale,
  req,
}: {
  doc?: { site?: unknown; slug?: unknown } | null
  locale?: string | null
  req: PayloadRequest
}): Promise<null | { origin: string; path: string; site: Site }> => {
  const raw = doc?.site
  const siteId = typeof raw === 'object' && raw !== null ? (raw as { id?: string }).id : raw

  if (!siteId || typeof doc?.slug !== 'string') return null

  const site = await req.payload.findByID({
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    id: String(siteId),
    req,
  })

  if (!site?.domain) return null

  return {
    origin: siteOrigin(site, req.origin),
    path: sitePath(site, locale ?? req.locale, doc.slug),
    site,
  }
}
