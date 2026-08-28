import { draftMode } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import React from 'react'

import { CollectionArchive } from '@/components/CollectionArchive'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { PageRange } from '@/components/PageRange'
import { localeHref } from '@/lib/locales'
import { postPath } from '@/lib/slug'
import { getSiteContext } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'
import { uiString } from '@/lib/ui-strings'

/** Three columns of cards; nine keeps the first screen one page of grid on a laptop. */
const PER_PAGE = 9

/**
 * The blog's front page: this site's posts, newest first, paginated.
 *
 * `sort: '-publishedAt'` rather than `-createdAt`, so a post written last month and
 * published today lands on top — which is what "newest" means to a reader, and what the
 * admin's `publishedAt` field exists for.
 */
export const PostsIndex: React.FC<{ page?: number }> = async ({ page = 1 }) => {
  const { isEnabled: draft } = await draftMode()
  const { locale, site } = await getSiteContext()

  if (!site) notFound()

  const { docs, page: currentPage, totalDocs, totalPages } = await findForSite('posts', site.id, {
    limit: PER_PAGE,
    locale,
    page,
    sort: '-publishedAt',
  })

  const current = currentPage ?? 1
  const base = localeHref(postPath(), locale, site.defaultLocale)

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <section className="container">
        <h1 className="text-3xl font-bold">{uiString('postsHeading', locale)}</h1>

        <div className="mt-10">
          <CollectionArchive posts={docs} />
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-4">
          <PageRange currentPage={current} limit={PER_PAGE} totalDocs={totalDocs} />

          {/* Words, not ‹ ›: a chevron is a directional glyph, and in an RTL column the
              pair swaps meaning — the reader has to know which way "previous" points.
              «قبلی»/«بعدی» are direction-free, and they say something to a screen reader. */}
          {totalPages > 1 && (
            <nav className="flex gap-4 text-sm font-medium">
              {current > 1 && (
                <Link className="hover:underline" href={`${base}?page=${current - 1}`}>
                  {uiString('previous', locale)}
                </Link>
              )}
              {current < totalPages && (
                <Link className="hover:underline" href={`${base}?page=${current + 1}`}>
                  {uiString('next', locale)}
                </Link>
              )}
            </nav>
          )}
        </div>
      </section>
    </article>
  )
}
