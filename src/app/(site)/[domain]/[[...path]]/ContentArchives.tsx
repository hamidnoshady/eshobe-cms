import { draftMode } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import React from 'react'

import type { ContentEntry, Media as MediaType } from '@/payload-types'
import type { ContentRouteMatch } from '@/lib/content-paths'

import { LivePreviewListener } from '@/components/LivePreviewListener'
import { Media } from '@/components/Media'
import { PageRange } from '@/components/PageRange'
import { entryPath, termArchivePath } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'
import { localeHref } from '@/lib/locales'
import { getSiteContext } from '@/lib/site-context'
import { uiString } from '@/lib/ui-strings'

import type { ContentDefinitions, EntriesPage } from './contentQueries'

import {
  queryContentDefinitions,
  queryTaxonomyTerms,
  queryTermArchivePage,
  queryTermAtPath,
  queryTypeArchivePage,
} from './contentQueries'

/**
 * The archive half of the custom-content fallback (issue #166 §3): a content
 * type's listing, a term's listing, and a taxonomy's own index of terms.
 *
 * Same contract as `PostsIndex` — newest first, paginated with `?page=`, and
 * words («قبلی»/«بعدی») rather than chevrons, for the RTL reason documented
 * there. Nine per page, matching the blog grid.
 */
const PER_PAGE = 9

type ArchiveProps = { match: ContentRouteMatch; page?: number }

export const ContentTypeArchive: React.FC<ArchiveProps> = async ({ match, page = 1 }) => {
  if (match.kind !== 'type-archive') notFound()

  const { types } = await queryContentDefinitions()
  const type = types.find((definition) => definition.id === match.typeId)

  if (!type) notFound()

  const entries = await queryTypeArchivePage(type.id, PER_PAGE, page)

  if (!entries) notFound()

  return (
    <EntriesListing
      basePath={entryArchiveBase(type)}
      entries={entries}
      heading={type.pluralLabel}
      types={types}
    />
  )
}

export const ContentTermArchive: React.FC<ArchiveProps> = async ({ match, page = 1 }) => {
  if (match.kind !== 'term-archive') notFound()

  const definitions = await queryContentDefinitions()
  const taxonomy = definitions.taxonomies.find(
    (definition) => definition.id === match.taxonomyId,
  )

  if (!taxonomy) notFound()

  const term = await queryTermAtPath(taxonomy.id, match.termSlugs)

  if (!term) notFound()

  const entries = await queryTermArchivePage(String(term.id), PER_PAGE, page)

  if (!entries) notFound()

  return (
    <EntriesListing
      basePath={termArchivePath(taxonomy, match.termSlugs)}
      entries={entries}
      heading={term.name}
      types={definitions.types}
    />
  )
}

export const TaxonomyIndex: React.FC<ArchiveProps> = async ({ match }) => {
  if (match.kind !== 'taxonomy-index') notFound()

  const { locale, site } = await getSiteContext()
  const { isEnabled: draft } = await draftMode()
  const { taxonomies } = await queryContentDefinitions()
  const taxonomy = taxonomies.find((definition) => definition.id === match.taxonomyId)

  if (!site || !taxonomy) notFound()

  const terms = await queryTaxonomyTerms(taxonomy.id)

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <section className="container">
        <h1 className="text-3xl font-bold">{taxonomy.pluralLabel}</h1>

        <ul className="mt-10 flex flex-wrap gap-3">
          {terms.map((term) => (
            <li key={term.id}>
              {// Root terms only: a hierarchical term's URL needs its whole
              // ancestor chain, which this index does not spell out.
              !taxonomy.hierarchical || !term.parent ? (
                <Link
                  className="rounded-full border px-4 py-2 hover:underline"
                  href={localeHref(
                    termArchivePath(taxonomy, [term.slug]),
                    locale,
                    site.defaultLocale,
                  )}
                >
                  {term.name}
                </Link>
              ) : (
                <span className="rounded-full border px-4 py-2">{term.name}</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </article>
  )
}

const entryArchiveBase = (type: ContentDefinitions['types'][number]): string =>
  `/${type.archiveSlug?.trim() || type.key}`

const EntriesListing: React.FC<{
  basePath: string
  entries: EntriesPage
  heading: string
  types: ContentDefinitions['types']
}> = async ({ basePath, entries, heading, types }) => {
  const { isEnabled: draft } = await draftMode()
  const { locale, site } = await getSiteContext()

  if (!site) notFound()

  const { docs, page: current, totalDocs, totalPages } = entries
  const base = localeHref(basePath, locale, site.defaultLocale)

  const hrefFor = (entry: ContentEntry): null | string => {
    const type = types.find((definition) => definition.id === idOf(entry.contentType))

    if (!type) return null

    return localeHref(entryPath(type, entry), locale, site.defaultLocale)
  }

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <section className="container">
        <h1 className="text-3xl font-bold">{heading}</h1>

        <div className="mt-10 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {docs.map((entry) => {
            const href = hrefFor(entry)
            const hero =
              entry.heroImage && typeof entry.heroImage === 'object'
                ? (entry.heroImage as MediaType)
                : null

            const card = (
              <>
                {hero && <Media imgClassName="aspect-[4/3] w-full object-cover" resource={hero} />}
                <div className="p-4">
                  <h2 className="text-lg font-semibold">{entry.title}</h2>
                  {entry.excerpt && <p className="mt-2 text-sm opacity-80">{entry.excerpt}</p>}
                </div>
              </>
            )

            return (
              <article className="overflow-hidden rounded-lg border" key={entry.id}>
                {href ? (
                  <Link className="block h-full hover:opacity-90" href={href}>
                    {card}
                  </Link>
                ) : (
                  card
                )}
              </article>
            )
          })}
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-4">
          <PageRange currentPage={current} limit={PER_PAGE} totalDocs={totalDocs} />

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
