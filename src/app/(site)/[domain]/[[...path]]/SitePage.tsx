import { draftMode } from 'next/headers'
import React from 'react'

import { RenderBlocks } from '@/blocks/RenderBlocks'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { RenderHero } from '@/heros/RenderHero'

import { ContentFallback } from './ContentFallback'
import { queryPage } from './queries'

/**
 * A CMS page: hero, then the layout blocks.
 *
 * `/` is a page like any other (`HOME_SLUG`), which is what lets a bare domain and a
 * bare `/en` both resolve without a `homePage` pointer on `sites`.
 *
 * A page miss is not yet a 404: the site's custom content types and taxonomies
 * (issue #166 §3) answer under their own archive bases, resolved by
 * `ContentFallback` — which is where an unknown slug finally becomes one.
 * Pages keep priority by construction: only a miss falls through.
 */
export const SitePage: React.FC<{ page?: number; slug: string }> = async ({ page, slug }) => {
  const { isEnabled: draft } = await draftMode()
  const cmsPage = await queryPage(slug)

  if (!cmsPage) return <ContentFallback page={page} slug={slug} />

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <RenderHero {...cmsPage.hero} />
      <RenderBlocks blocks={cmsPage.layout} />
    </article>
  )
}
