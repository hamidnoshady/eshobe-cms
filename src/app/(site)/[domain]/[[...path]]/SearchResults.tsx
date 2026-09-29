import Link from 'next/link'
import { notFound } from 'next/navigation'
import React from 'react'

import { PageRange } from '@/components/PageRange'
import { Search } from '@/search/Component'
import { formatDate } from '@/lib/format'
import { localeHref } from '@/lib/locales'
import { postPath } from '@/lib/slug'
import { getSiteContext } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'
import { uiString } from '@/lib/ui-strings'

const PER_PAGE = 10

/**
 * Site search over the `search` collection the search plugin maintains.
 *
 * Searching the *index* rather than `posts` directly is the point: the index carries the
 * SEO description and slug the plugin copies at publish time, and it is what the
 * `like` operators can actually match without a rich-text scan per row.
 *
 * `q` is trimmed before it reaches the query because Payload's `like` is a wrapped
 * `%value%` — an untrimmed space would quietly turn «زن» into «زن » and match nothing,
 * which reads as "the search is broken" rather than "the query had a space in it".
 */
export const SearchResults: React.FC<{ page?: number; q?: string }> = async ({
  page = 1,
  q,
}) => {
  const { locale, site } = await getSiteContext()

  if (!site) notFound()

  const term = (q ?? '').replace(/[%_]/g, '').trim()

  const { docs, page: currentPage, totalDocs } = await findForSite('search', site.id, {
    limit: PER_PAGE,
    locale,
    page,
    sort: term ? undefined : '-createdAt',
    where: term
      ? {
          or: [{ title: { like: term } }, { 'meta.description': { like: term } }],
        }
      : undefined,
  })

  // The index's own `slug` is a single value shared by every locale, so after the second
  // locale syncs it holds *that* locale's slug and the Persian result links to an English
  // URL that 404s. The post itself has the slug per locale: resolve each hit through it,
  // and drop a hit the post has no translation for rather than link to nothing.
  const postIds = docs
    .map((doc) => {
      const ref = doc.doc as unknown as { value?: { id?: string } | string } | null
      return typeof ref?.value === 'object' ? ref.value?.id : ref?.value
    })
    .filter((id): id is string => typeof id === 'string')
  const translated = postIds.length
    ? await findForSite('posts', site.id, {
        depth: 0,
        fallbackLocale: false,
        limit: postIds.length,
        locale,
        pagination: false,
        select: { slug: true },
        where: { id: { in: postIds } },
      })
    : { docs: [] }
  const slugByPost = new Map(translated.docs.map((post) => [String(post.id), post.slug]))
  const hits = docs.flatMap((doc) => {
    const ref = doc.doc as unknown as { value?: { id?: string } | string } | null
    const postId = typeof ref?.value === 'object' ? ref.value?.id : ref?.value
    const slug = postId ? slugByPost.get(postId) : null
    return slug ? [{ doc, slug }] : []
  })

  return (
    <article className="pt-16 pb-24">
      <section className="container">
        <h1 className="text-3xl font-bold">{uiString('searchPosts', locale)}</h1>

        <div className="mt-6 max-w-md">
          <Search />
        </div>

        <div className="mt-10 space-y-8">
          {hits.map(({ doc, slug }) => {
            const href = localeHref(postPath(slug), locale, site.defaultLocale)
            const title = doc.title || doc.meta?.title || uiString('untitled', locale)

            return (
              <div className="border-b border-border pb-6" key={doc.id}>
                <Link className="text-xl font-semibold hover:underline" href={href}>
                  {title}
                </Link>

                {doc.meta?.description && (
                  <p className="mt-2 text-muted-foreground">{doc.meta.description}</p>
                )}

                {doc.createdAt && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {formatDate(doc.createdAt, locale)}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-10">
          <PageRange
            currentPage={currentPage}
            emptyLabel={term ? undefined : uiString('search', locale)}
            itemLabel={uiString('posts', locale)}
            limit={PER_PAGE}
            totalDocs={totalDocs}
          />
        </div>
      </section>
    </article>
  )
}
