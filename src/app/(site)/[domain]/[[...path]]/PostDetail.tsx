import { draftMode } from 'next/headers'
import { notFound } from 'next/navigation'
import React from 'react'

import type { Post } from '@/payload-types'

import { RelatedPosts } from '@/blocks/RelatedPosts/Component'
import RichText from '@/components/RichText'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { PostHero } from '@/heros/PostHero'

import { queryPost } from './queries'

/**
 * One post: hero, rich text (whose embedded banner/code/media blocks are rendered by
 * the same `RichText` the pages use), then whatever the editor related below it.
 */
export const PostDetail: React.FC<{ slug: string }> = async ({ slug }) => {
  const { isEnabled: draft } = await draftMode()
  const post = await queryPost(slug)

  if (!post) notFound()

  const related = (post.relatedPosts ?? []).filter(
    (doc): doc is Post => typeof doc === 'object' && doc !== null,
  )

  return (
    <article className="pb-24">
      {draft && <LivePreviewListener />}

      <PostHero post={post} />

      <div className="container my-16">
        <RichText data={post.content} enableGutter={false} />
      </div>

      {related.length > 0 && <RelatedPosts className="mb-16" docs={related} />}
    </article>
  )
}
