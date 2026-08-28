import { draftMode } from 'next/headers'
import { notFound } from 'next/navigation'
import React from 'react'

import { RenderBlocks } from '@/blocks/RenderBlocks'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { RenderHero } from '@/heros/RenderHero'

import { queryPage } from './queries'

/**
 * A CMS page: hero, then the layout blocks.
 *
 * `/` is a page like any other (`HOME_SLUG`), which is what lets a bare domain and a
 * bare `/en` both resolve without a `homePage` pointer on `sites`.
 */
export const SitePage: React.FC<{ slug: string }> = async ({ slug }) => {
  const { isEnabled: draft } = await draftMode()
  const page = await queryPage(slug)

  if (!page) notFound()

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <RenderHero {...page.hero} />
      <RenderBlocks blocks={page.layout} />
    </article>
  )
}
