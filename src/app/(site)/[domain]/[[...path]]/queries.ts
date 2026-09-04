import type { TypedUser } from 'payload'

import { draftMode } from 'next/headers'
import { cache } from 'react'

import type { Page, Post, Product } from '@/payload-types'

import { getSiteContext, getViewer } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'

/**
 * The cached readers that `generateMetadata` and the page body both need.
 *
 * `cache` is not a performance courtesy here: metadata and render are two calls in one
 * request, and an uncached second read is a second query for every page view on every
 * locale. And every read goes through `findForSite`, so both are tenant-scoped and
 * access-controlled — the blog is not a way around that rule.
 *
 * `draft` + `user` belong together: with `draft: true` and no user the plugin cannot
 * narrow the read to *someone's* sites, so a preview link would be a cross-tenant
 * draft reader. Anonymous requests therefore never see drafts, published or not.
 */
const draftAndViewer = async (): Promise<{ draft: boolean; user: null | TypedUser }> => {
  const { isEnabled: draft } = await draftMode()

  return { draft, user: draft ? await getViewer() : null }
}

export const queryPage = cache(async (slug: string): Promise<Page | null> => {
  const { locale, serving, site } = await getSiteContext()

  if (!site || !serving) return null

  const { draft, user } = await draftAndViewer()

  const { docs } = await findForSite('pages', site.id, {
    draft,
    limit: 1,
    locale,
    pagination: false,
    user,
    where: { slug: { equals: slug } },
  })

  return docs[0] ?? null
})

/**
 * A post by slug, at depth 1: the hero needs its image and the footer grid needs the
 * related posts, and a second query per relationship would be a worse trade than the
 * wider read.
 */
export const queryPost = cache(async (slug: string): Promise<Post | null> => {
  const { locale, serving, site } = await getSiteContext()

  if (!site || !serving) return null

  const { draft, user } = await draftAndViewer()

  const { docs } = await findForSite('posts', site.id, {
    depth: 1,
    draft,
    limit: 1,
    locale,
    pagination: false,
    user,
    where: { slug: { equals: slug } },
  })

  return docs[0] ?? null
})

export const queryProduct = cache(async (slug: string): Promise<Product | null> => {
  const { locale, serving, site } = await getSiteContext()

  if (!site || !serving) return null

  const { draft, user } = await draftAndViewer()

  const { docs } = await findForSite('products', site.id, {
    depth: 1,
    draft,
    limit: 1,
    locale,
    pagination: false,
    user,
    where: { slug: { equals: slug } },
  })

  return docs[0] ?? null
})
