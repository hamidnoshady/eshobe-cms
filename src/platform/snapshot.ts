import type { CollectionSlug, PayloadRequest, TypedLocale } from 'payload'

import {
  snapshotCounts,
  SNAPSHOT_COLLECTIONS,
  stripSnapshotFields,
  summarizeImportPlan,
  type ImportPlanRow,
  type SnapshotCollection,
} from '@/lib/platform-control'

/**
 * Sync a site's content out of, and back into, the CMS — the two directions the
 * POS console's «همگام‌سازی» button drives.
 *
 * ## Shape
 *
 * A snapshot is `{ site, locales, documents: { [collection]: { [locale]: doc[] } } }`.
 * Locale-keyed rather than `locale: 'all'`-shaped because that is the only form that
 * imports correctly: CLAUDE.md's rule for a second locale is that an unlocalized
 * array (`layout`) is *replaced*, not merged, so the row ids have to survive the
 * round trip. They do — `stripSnapshotFields` removes only the document's own top
 * level, so every block's `id` inside `layout` comes back exactly as it left, and a
 * second-locale write is a translation instead of a rewrite. The site's own default
 * locale is always written first for the same reason: creating a document on a
 * translation would file its Persian content under the wrong locale.
 *
 * ## What it is not
 *
 * Not a backup, and not media. `media` is deliberately absent from
 * `SNAPSHOT_COLLECTIONS`: the files live in object storage (WAVE-6), a JSON snapshot
 * cannot carry them, and one that listed them without their bytes would read as a
 * backup that is not one. The deployment's own backups cover files; this covers
 * content.
 *
 * ## The one refusal
 *
 * An import writes only into the site its URL names, and refuses a snapshot that was
 * taken from a *different* site unless the caller passes `force`. Relationship values
 * (a post's categories, a hero image) are document ids from the source site, and on
 * another site they name rows that site does not own — which is the tenant-leak
 * shape this platform spends `src/access/siteRead.ts` preventing. With `force` the
 * write is attempted per row and the failures are listed, rather than a whole import
 * dying on the first bad reference.
 */

const EXPORT_PAGE_LIMIT = 1_000

export type SnapshotDocuments = Partial<Record<SnapshotCollection, Record<string, Record<string, unknown>[]>>>

export type SiteSnapshot = {
  counts: Record<string, number>
  documents: SnapshotDocuments
  generatedAt: string
  locales: string[]
  site: {
    availableLocales: string[]
    defaultLocale: string
    domain: string
    id: string
    name: string
    status: string
    type: string
  }
  truncated: string[]
}

/** The site's locales with its default first — the write order an import has to use. */
export const localeOrder = (site: { availableLocales?: unknown; defaultLocale?: unknown }): string[] => {
  const available = Array.isArray(site.availableLocales)
    ? (site.availableLocales as unknown[]).map(String)
    : []
  const fallback = typeof site.defaultLocale === 'string' && site.defaultLocale ? site.defaultLocale : 'fa'
  const rest = available.filter((code) => code !== fallback)
  return [fallback, ...rest]
}

export const exportSiteSnapshot = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  collections: SnapshotCollection[],
): Promise<SiteSnapshot> => {
  const siteId = String(site.id)
  const locales = localeOrder(site)
  const documents: SnapshotDocuments = {}
  const truncated: string[] = []

  for (const collection of collections) {
    const perLocale: Record<string, Record<string, unknown>[]> = {}
    for (const locale of locales) {
      const result = await req.payload.find({
        collection: collection as CollectionSlug,
        depth: 0,
        draft: true,
        limit: EXPORT_PAGE_LIMIT,
        locale: locale as TypedLocale,
        // The caller is a platform operator (see src/endpoints/platformControl.ts);
        // a tenant-scoped read would be scoped by a `Host` this request does not have.
        // The `where` below is what confines the answer to the one site.
        overrideAccess: true,
        req,
        sort: 'createdAt',
        where: { site: { equals: siteId } },
      })
      if (result.totalDocs > result.docs.length) truncated.push(`${collection}:${locale}`)
      perLocale[locale] = (result.docs as unknown as Record<string, unknown>[]).map(stripSnapshotFields)
    }
    documents[collection] = perLocale
  }

  return {
    counts: snapshotCounts(
      Object.fromEntries(
        Object.entries(documents).map(([name, byLocale]) => [
          name,
          byLocale?.[locales[0]] ?? [],
        ]),
      ) as Parameters<typeof snapshotCounts>[0],
    ),
    documents,
    generatedAt: new Date().toISOString(),
    locales,
    site: {
      availableLocales: Array.isArray(site.availableLocales)
        ? (site.availableLocales as unknown[]).map(String)
        : [],
      defaultLocale: String(site.defaultLocale ?? 'fa'),
      domain: String(site.domain ?? ''),
      id: siteId,
      name: String(site.name ?? ''),
      status: String(site.status ?? 'active'),
      type: String(site.type ?? 'business'),
    },
    truncated,
  }
}

export type ImportResult = {
  errors: { collection: string; key: null | string; locale: string; message: string }[]
  plan: ImportPlanRow[]
  summary: { created: number; skipped: number; updated: number }
}

export type ImportOptions = {
  collections: SnapshotCollection[]
  dryRun: boolean
  force: boolean
  snapshot: { documents?: unknown; site?: unknown }
}

const asDocs = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value.filter((row) => row && typeof row === 'object') as Record<string, unknown>[]) : []

export const importSiteSnapshot = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  options: ImportOptions,
): Promise<{ ok: false; reason: 'site_mismatch' } | ({ ok: true } & ImportResult)> => {
  const siteId = String(site.id)
  const source = (options.snapshot.site ?? {}) as { id?: unknown }
  if (!options.force && source.id !== undefined && String(source.id) !== siteId) {
    return { ok: false, reason: 'site_mismatch' }
  }

  const documents = (options.snapshot.documents ?? {}) as Record<string, unknown>
  const locales = localeOrder(site)
  const plan: ImportPlanRow[] = []
  const errors: ImportResult['errors'] = []

  for (const collection of options.collections) {
    const byLocale = (documents[collection] ?? {}) as Record<string, unknown>
    const kind = SNAPSHOT_COLLECTIONS[collection]
    // Every document is identified once, from the default locale, and then written in
    // each locale the site serves — so a translation lands on the row the first pass
    // created rather than making a second row with the same slug.
    const resolvedIds = new Map<string, string>()

    for (const locale of locales) {
      const docs = asDocs(byLocale[locale])
      for (const [index, raw] of docs.entries()) {
        const data = stripSnapshotFields(raw)
        const key =
          kind === 'slug'
            ? typeof data.slug === 'string' && data.slug
              ? data.slug
              : null
            : collection
        if (kind === 'slug' && !key) {
          errors.push({ collection, key: null, locale, message: 'سند بدون نامک قابل درج نیست.' })
          continue
        }
        const mapKey = kind === 'slug' ? `${key}` : `${collection}:${index}`

        try {
          let existingId = resolvedIds.get(mapKey) ?? null
          if (!existingId) {
            const found = await req.payload.find({
              collection: collection as CollectionSlug,
              depth: 0,
              draft: true,
              limit: 1,
              locale: locale as TypedLocale,
              overrideAccess: true,
              req,
              where:
                kind === 'slug'
                  ? { and: [{ site: { equals: siteId } }, { slug: { equals: key } }] }
                  : { site: { equals: siteId } },
            })
            existingId = found.docs[0] ? String((found.docs[0] as { id: unknown }).id) : null
          }

          if (options.dryRun) {
            plan.push({ action: existingId ? 'update' : 'create', collection, key })
            if (existingId) resolvedIds.set(mapKey, existingId)
            continue
          }

          if (existingId) {
            await req.payload.update({
              id: existingId,
              collection: collection as CollectionSlug,
              // `site` is never taken from the payload — the same rule
              // `forceApiKeySite` applies to a site key's own writes.
              data: { ...data, site: siteId },
              depth: 0,
              locale: locale as TypedLocale,
              overrideAccess: true,
              req,
            })
            resolvedIds.set(mapKey, existingId)
            plan.push({ action: 'update', collection, key })
          } else {
            const created = await req.payload.create({
              collection: collection as CollectionSlug,
              data: { ...data, site: siteId },
              depth: 0,
              locale: locale as TypedLocale,
              overrideAccess: true,
              req,
            })
            resolvedIds.set(mapKey, String((created as { id: unknown }).id))
            plan.push({ action: 'create', collection, key })
          }
        } catch (error) {
          // One unresolvable reference (a hero image or a category that belongs to the
          // site the snapshot came from) must cost that row, not the import.
          plan.push({ action: 'skip', collection, key, reason: 'write_failed' })
          errors.push({
            collection,
            key,
            locale,
            message: (error as Error)?.message ?? 'درج ناموفق بود.',
          })
        }
      }
    }
  }

  return { errors, ok: true, plan, summary: summarizeImportPlan(plan) }
}
