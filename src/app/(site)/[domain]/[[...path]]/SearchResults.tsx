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

  return (
    <article className="pt-16 pb-24">
      <section className="container">
        <h1 className="text-3xl font-bold">{uiString('searchPosts', locale)}</h1>

        <div className="mt-6 max-w-md">
          <Search />
        </div>

        <div className="mt-10 space-y-8">
          {docs.map((doc) => {
            const slug = typeof doc.slug === 'string' ? doc.slug : null
            const href = slug ? localeHref(postPath(slug), locale, site.defaultLocale) : null
            const title = doc.title || doc.meta?.title || uiString('untitled', locale)

            return (
              <div className="border-b border-border pb-6" key={doc.id}>
                {href ? (
                  <Link className="text-xl font-semibold hover:underline" href={href}>
                    {title}
                  </Link>
                ) : (
                  <p className="text-xl font-semibold">{title}</p>
                )}

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
