import type { TypedUser } from 'payload'

import { draftMode } from 'next/headers'
import { cache } from 'react'

import type {
  ContentEntry,
  ContentTypeDefinition,
  TaxonomyDefinition,
  TaxonomyTerm,
} from '@/payload-types'

import { idOf, isUuid } from '@/lib/ids'
import { matchContentRoute, type ContentRouteMatch } from '@/lib/content-paths'
import { getSiteContext, getViewer } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'

/**
 * The cached readers behind the custom-content fallback (issue #166 §3).
 *
 * Custom types and taxonomies cannot be Next.js folders — their URL bases are
 * rows in the site's own `content-type-definitions` / `taxonomy-definitions`
 * — so the router (`SitePage`, on a page miss) resolves them here, at request
 * time, with the same rules the CMS pages live by: every read goes through
 * `findForSite` (tenant-scoped, access-controlled), anonymous readers only
 * ever see `published` entries (that gate is the collection's own read
 * access, which `overrideAccess: false` faithfully applies), and a previewing
 * signed-in viewer can see their drafts exactly as on posts.
 *
 * Entries carry a WordPress-shaped `status` instead of Payload drafts, so
 * nothing here passes `draft: true`; presenting the viewer is what lifts the
 * published-only filter for preview.
 */
const viewerWhenDraft = async (): Promise<{ draft: boolean; user: null | TypedUser }> => {
  const { isEnabled: draft } = await draftMode()

  return { draft, user: draft ? await getViewer() : null }
}

export type ContentDefinitions = {
  taxonomies: TaxonomyDefinition[]
  types: ContentTypeDefinition[]
}

/** One site's routing table: its content types and taxonomies as the active locale spells them. */
export const queryContentDefinitions = cache(async (): Promise<ContentDefinitions> => {
  const { locale, serving, site } = await getSiteContext()

  if (!site || !serving) return { taxonomies: [], types: [] }

  const { draft, user } = await viewerWhenDraft()
  const shared = {
    cachePublic: !draft && !user,
    depth: 0,
    locale,
    pagination: false,
    user,
  } as const

  const [{ docs: types }, { docs: taxonomies }] = await Promise.all([
    findForSite('content-type-definitions', site.id, { ...shared, sort: 'key' }),
    findForSite('taxonomy-definitions', site.id, { ...shared, sort: 'key' }),
  ])

  return { taxonomies, types }
})

/** The match a path makes against the site's definitions, or `null` for "not custom content". */
export const queryContentRoute = cache(
  async (segments: string[]): Promise<ContentRouteMatch | null> =>
    matchContentRoute(await queryContentDefinitions(), segments),
)

export type ContentEntryWithType = { entry: ContentEntry; type: ContentTypeDefinition }

/**
 * One entry by its route match, at depth 2: the rendered page needs the type
 * (labels, field schema, permalink template) and the term chips
 * (`termRelations → term`) without a query per relation.
 */
export const queryContentEntry = cache(
  async (match: ContentRouteMatch): Promise<ContentEntryWithType | null> => {
    if (match.kind !== 'entry') return null
    // An id-templated URL hands the query whatever segment the crawler typed;
    // anything non-UUID is a 404 here, not a Postgres error (`@/lib/ids`).
    if ('entryId' in match && !isUuid(match.entryId)) return null

    const { locale, serving, site } = await getSiteContext()

    if (!site || !serving) return null

    const { types } = await queryContentDefinitions()
    const type = types.find((definition) => definition.id === match.typeId)

    if (!type) return null

    const { draft, user } = await viewerWhenDraft()

    const { docs } = await findForSite('content-entries', site.id, {
      cachePublic: !draft && !user,
      depth: 2,
      limit: 1,
      locale,
      pagination: false,
      user,
      where: {
        and: [
          { contentType: { equals: match.typeId } },
          'entryId' in match
            ? { id: { equals: match.entryId } }
            : { slug: { equals: match.slug } },
        ],
      },
    })

    return docs[0] ? { entry: docs[0], type } : null
  },
)

export type EntriesPage = {
  docs: ContentEntry[]
  page: number
  totalDocs: number
  totalPages: number
}

const toEntriesPage = (docs: {
  docs: ContentEntry[]
  page?: number
  totalDocs: number
  totalPages: number
}): EntriesPage => ({
  docs: docs.docs,
  page: docs.page ?? 1,
  totalDocs: docs.totalDocs,
  totalPages: docs.totalPages,
})

/** A content type's archive: its published entries, newest first (same rule as the blog). */
export const queryTypeArchivePage = cache(
  async (typeId: string, limit: number, page: number): Promise<EntriesPage | null> => {
    const { locale, serving, site } = await getSiteContext()

    if (!site || !serving) return null

    const { draft, user } = await viewerWhenDraft()

    const result = await findForSite('content-entries', site.id, {
      cachePublic: !draft && !user,
      depth: 1,
      limit,
      locale,
      page,
      sort: '-publishedAt',
      user,
      where: { contentType: { equals: typeId } },
    })

    return toEntriesPage(result)
  },
)

/**
 * The term a path names, verifying its ancestor chain segment by segment.
 * Term slugs are unique per taxonomy (as in WordPress), so the leaf is found
 * by slug; a hierarchical path then has to walk up through exactly the
 * slugs the URL claimed — `/genre/wrong-parent/child` is a 404, not a
 * shortcut to `child`.
 */
export const queryTermAtPath = cache(
  async (taxonomyId: string, termSlugs: string[]): Promise<null | TaxonomyTerm> => {
    const { locale, serving, site } = await getSiteContext()

    if (!site || !serving || termSlugs.length === 0) return null

    const { draft, user } = await viewerWhenDraft()

    const { docs: terms } = await findForSite('taxonomy-terms', site.id, {
      cachePublic: !draft && !user,
      depth: 0,
      locale,
      pagination: false,
      user,
      where: { taxonomy: { equals: taxonomyId } },
    })

    const byId = new Map(terms.map((term) => [String(term.id), term]))
    let current = terms.find((term) => term.slug === termSlugs[termSlugs.length - 1])

    if (!current) return null

    for (let index = termSlugs.length - 2; index >= 0; index -= 1) {
      const parentId = idOf(current.parent)
      const parent = parentId ? byId.get(parentId) : undefined

      if (!parent || parent.slug !== termSlugs[index]) return null

      current = parent
    }

    if (idOf(current.parent)) return null

    return terms.find((term) => term.slug === termSlugs[termSlugs.length - 1]) ?? null
  },
)

/** The published entries filed under one term, newest first. */
export const queryTermArchivePage = cache(
  async (
    termId: string,
    limit: number,
    page: number,
  ): Promise<EntriesPage | null> => {
    const { locale, serving, site } = await getSiteContext()

    if (!site || !serving) return null

    const { draft, user } = await viewerWhenDraft()
    const shared = { cachePublic: !draft && !user, locale, user } as const

    const { docs: relations } = await findForSite('entry-term-relations', site.id, {
      ...shared,
      depth: 0,
      pagination: false,
      select: { entry: true },
      where: { term: { equals: termId } },
    })

    const entryIds = relations
      .map((relation) => idOf((relation as { entry?: unknown }).entry))
      .filter((id): id is string => Boolean(id))

    if (entryIds.length === 0) {
      return { docs: [], page: 1, totalDocs: 0, totalPages: 1 }
    }

    const result = await findForSite('content-entries', site.id, {
      ...shared,
      depth: 1,
      limit,
      page,
      sort: '-publishedAt',
      where: { id: { in: entryIds } },
    })

    return toEntriesPage(result)
  },
)

/** Every term of a taxonomy, for the taxonomy's own index page. */
export const queryTaxonomyTerms = cache(
  async (taxonomyId: string): Promise<TaxonomyTerm[]> => {
    const { locale, serving, site } = await getSiteContext()

    if (!site || !serving) return []

    const { draft, user } = await viewerWhenDraft()

    const { docs } = await findForSite('taxonomy-terms', site.id, {
      cachePublic: !draft && !user,
      depth: 0,
      locale,
      pagination: false,
      sort: 'name',
      user,
      where: { taxonomy: { equals: taxonomyId } },
    })

    return docs
  },
)
