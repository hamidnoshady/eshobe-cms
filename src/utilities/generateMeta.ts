import type { Metadata } from 'next'

import type { Media, Page, Post, Config } from '../payload-types'

import { getSiteContext } from '@/lib/site-context'
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
  const { site } = await getSiteContext()

  const ogImage = getImageURL(doc?.meta?.image)
  const name = site?.name
  const own = doc?.meta?.title || doc?.title
  const title = [own, name].filter(Boolean).join(' | ') || (name ?? '')

  return {
    description: doc?.meta?.description,
    openGraph: mergeOpenGraph({
      description: doc?.meta?.description || '',
      images: ogImage ? [{ url: ogImage }] : undefined,
      title,
      url: Array.isArray(doc?.slug) ? doc?.slug.join('/') : '/',
    }),
    title,
  }
}
