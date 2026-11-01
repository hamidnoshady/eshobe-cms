import { draftMode } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import React from 'react'

import type { EntryTermRelation, Media as MediaType, TaxonomyTerm } from '@/payload-types'
import type { ContentRouteMatch } from '@/lib/content-paths'

import { LivePreviewListener } from '@/components/LivePreviewListener'
import { Media } from '@/components/Media'
import RichText from '@/components/RichText'
import { archiveSlugOf, termArchivePath } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'
import { localeHref } from '@/lib/locales'
import { getSiteContext } from '@/lib/site-context'

import { queryContentDefinitions, queryContentEntry } from './contentQueries'

/**
 * One custom entry on the built-in renderer (issue #166 §3): title, image,
 * body, then the type's own fields as a plain definition list and its term
 * filings as links to their archives.
 *
 * This is deliberately the *floor*, not the ceiling: a deployed theme renders
 * the same entry from the same API with its own design. What the floor must
 * never do is 404 a migrated portfolio because no theme exists yet — or print
 * `preservedHtml` (page-builder output Eshobe could not translate) as markup.
 * It renders as inert text, which React escaping does for free.
 */
export const ContentEntryDetail: React.FC<{ match: ContentRouteMatch }> = async ({ match }) => {
  const { isEnabled: draft } = await draftMode()
  const { locale, site } = await getSiteContext()
  const resolved = await queryContentEntry(match)

  if (!site || !resolved) notFound()

  const { entry, type } = resolved
  const hero =
    entry.heroImage && typeof entry.heroImage === 'object'
      ? (entry.heroImage as MediaType)
      : null

  const fieldRows = (type.fieldSchema ?? []).flatMap((field) => {
    const value = (entry.fieldValues as Record<string, unknown> | null | undefined)?.[field.key]
    const text = displayValue(value)

    return text === null ? [] : [{ key: field.key, label: field.label, text }]
  })

  const { taxonomies } = await queryContentDefinitions()
  const termLinks = (entry.termRelations?.docs ?? []).flatMap((relation) => {
    if (!relation || typeof relation !== 'object') return []

    const term = (relation as EntryTermRelation).term

    if (!term || typeof term !== 'object' || !term.slug) return []

    const taxonomy = taxonomies.find(
      (definition) => definition.id === idOf(term.taxonomy),
    )

    if (!taxonomy) return []

    // A hierarchical term's URL carries its whole ancestor chain, which a
    // depth-2 read cannot spell out — only root terms link in this renderer.
    const href =
      !taxonomy.hierarchical || !term.parent
        ? localeHref(termArchivePath(taxonomy, [term.slug]), locale, site.defaultLocale)
        : null

    return [
      {
        href,
        key: String(term.id),
        name: (term as TaxonomyTerm).name,
      },
    ]
  })

  return (
    <article className="pt-16 pb-24">
      {draft && <LivePreviewListener />}

      <div className="container">
        <p className="text-sm font-medium opacity-70">{type.pluralLabel}</p>
        <h1 className="mt-2 text-3xl font-bold">{entry.title}</h1>

        {entry.excerpt && <p className="mt-4 text-lg opacity-80">{entry.excerpt}</p>}

        {hero && (
          <Media className="mt-8" imgClassName="w-full rounded-lg" resource={hero} />
        )}

        {entry.body && (
          <div className="my-12">
            <RichText data={entry.body} enableGutter={false} />
          </div>
        )}

        {entry.preservedHtml && (
          <pre className="my-12 overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-6 text-sm">
            {entry.preservedHtml}
          </pre>
        )}

        {fieldRows.length > 0 && (
          <dl className="my-12 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {fieldRows.map((row) => (
              <div key={row.key}>
                <dt className="text-sm font-medium opacity-70">{row.label}</dt>
                <dd className="mt-1">{row.text}</dd>
              </div>
            ))}
          </dl>
        )}

        {termLinks.length > 0 && (
          <ul className="mt-12 flex flex-wrap gap-2">
            {termLinks.map((link) => (
              <li key={link.key}>
                {link.href ? (
                  <Link
                    className="rounded-full border px-3 py-1 text-sm hover:underline"
                    href={link.href}
                  >
                    {link.name}
                  </Link>
                ) : (
                  <span className="rounded-full border px-3 py-1 text-sm">{link.name}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {type.hasArchive !== false && (
          <p className="mt-12">
            <Link
              className="font-medium hover:underline"
              href={localeHref(`/${archiveSlugOf(type)}`, locale, site.defaultLocale)}
            >
              {type.pluralLabel}
            </Link>
          </p>
        )}
      </div>
    </article>
  )
}

/**
 * A field value as the fallback renderer can honestly print it. Scalars and
 * scalar lists print; nested structures (groups, repeaters, relationships,
 * media ids) are a theme's job — printing raw ids would be worse than
 * printing nothing.
 */
const displayValue = (value: unknown): null | string => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '✓' : '—'

  if (Array.isArray(value)) {
    const parts = value.map(displayValue).filter((part): part is string => part !== null)

    return parts.length > 0 ? parts.join('، ') : null
  }

  return null
}
