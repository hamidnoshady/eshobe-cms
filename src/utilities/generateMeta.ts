import type { Metadata } from 'next'

import type { Media, Page, Post, Config, Site } from '../payload-types'

import { alternateUrls, localeSlugs } from '@/lib/alternates'
import { getSiteContext } from '@/lib/site-context'
import { siteOrigin, siteUrl } from '@/lib/site-url'
import { mergeOpenGraph } from './mergeOpenGraph'
import { getServerSideURL } from './getURL'

const getImageURL = (image?: Media | Config['db']['defaultIDType'] | null) => {
  if (!image || typeof image !== 'object' || !('url' in image)) return undefined

  const serverUrl = getServerSideURL()

  return serverUrl + (image.sizes?.og?.url ?? image.url)
}

/**
 * The generated card for a document that has no uploaded OG image.
 *
 * Per locale, because the card renders the document's own title and reads
 * right-to-left in Persian — one image cannot serve both. `v` is the document's
 * `updatedAt`: Facebook, X and Telegram all cache an OG image by URL more or less
 * forever, so a title fixed after the first share would otherwise never update.
 */
const generatedImageURL = (
  site: Site,
  { locale, slug, updatedAt }: { locale: string; slug?: null | string; updatedAt?: null | string },
): string => {
  const params = new URLSearchParams({ locale, slug: slug ?? '' })

  if (updatedAt) params.set('v', String(Date.parse(updatedAt) || ''))

  return `${siteOrigin(site)}/og?${params}`
}

/**
 * The suffix is the site's own name — the template hardcoded "Payload Website
 * Template", which put our vendor's branding in every customer's browser tab.
 * Same for the fallback OG image: none at all beats another company's logo.
 */
export const generateMeta = async (args: {
  /** Which collection the document came from — hreflang re-reads it per locale. */
  collection?: 'pages' | 'posts'
  doc: Partial<Page> | Partial<Post> | null
}): Promise<Metadata> => {
  const { collection = 'pages', doc } = args
  const { locale, site } = await getSiteContext()

  const name = site?.name
  const own = doc?.meta?.title || doc?.title
  const title = [own, name].filter(Boolean).join(' | ') || (name ?? '')

  /**
   * The absolute URL on the customer's own domain. The template joined
   * `doc.slug` — an array in its posts config, a string here — onto the admin's
   * origin, so every canonical and OG tag pointed at a domain the customer does not
   * own, and the home page at `/home`. `siteUrl` is the same function the preview
   * button and the SEO tab use.
   */
  const url = site ? siteUrl(site, { locale, slug: doc?.slug }) : undefined

  const ogImage =
    getImageURL(doc?.meta?.image) ??
    (site && doc?.slug
      ? generatedImageURL(site, { locale, slug: doc.slug, updatedAt: doc.updatedAt })
      : undefined)

  /**
   * `hreflang` for every locale this document is translated into, plus `x-default`.
   * Absent when the site serves one locale: a single self-referencing alternate says
   * nothing that the canonical has not already said.
   */
  const languages =
    site && doc?.id ? alternateUrls(site, await localeSlugs(collection, site, doc.id)) : {}

  return {
    alternates: url
      ? {
          canonical: url,
          languages: Object.keys(languages).length > 2 ? languages : undefined,
        }
      : undefined,
    description: doc?.meta?.description,
    openGraph: mergeOpenGraph({
      description: doc?.meta?.description || '',
      images: ogImage ? [{ url: ogImage }] : undefined,
      locale,
      title,
      url,
    }),
    title,
  }
}
