import type { Metadata } from 'next'

import type { Media, Page, Post, Config } from '../payload-types'

import { getSiteContext } from '@/lib/site-context'
import { siteUrl } from '@/lib/site-url'
import { mergeOpenGraph } from './mergeOpenGraph'
import { getServerSideURL } from './getURL'

const getImageURL = (image?: Media | Config['db']['defaultIDType'] | null) => {
  if (!image || typeof image !== 'object' || !('url' in image)) return undefined

  const serverUrl = getServerSideURL()

  return serverUrl + (image.sizes?.og?.url ?? image.url)
}

/**
 * The suffix is the site's own name — the template hardcoded "Payload Website
 * Template", which put our vendor's branding in every customer's browser tab.
 * Same for the fallback OG image: none at all beats another company's logo.
 */
export const generateMeta = async (args: {
  doc: Partial<Page> | Partial<Post> | null
}): Promise<Metadata> => {
  const { doc } = args
  const { locale, site } = await getSiteContext()

  const ogImage = getImageURL(doc?.meta?.image)
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

  return {
    alternates: url ? { canonical: url } : undefined,
    description: doc?.meta?.description,
    openGraph: mergeOpenGraph({
      description: doc?.meta?.description || '',
      images: ogImage ? [{ url: ogImage }] : undefined,
      title,
      url,
    }),
    title,
  }
}
