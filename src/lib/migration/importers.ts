import { isMachineKey, isValidArchiveSlug } from '@/lib/content-paths'
import { CUSTOM_FIELD_RELATION_COLLECTIONS } from '@/lib/custom-fields'
import { idOf } from '@/lib/ids'
import { WordPressApiError } from '@/lib/wordpress/client'
import { paymentProviders } from '@/payments'
import { slugify } from '@/lib/slug'
import { classifyCptCapability, type DiscoveredPostType, type DiscoveredTaxonomy } from '@/lib/wordpress/discovery'
import { reconcileWooOrderMoney } from '@/lib/wordpress/dry-run'
import {
  mapWordPressStatus,
  mapWooOrderStatus,
  preserveWordPressSlug,
} from '@/lib/wordpress/mapping'

import {
  asArray,
  asRecord,
  checkControl,
  commerceAllowed,
  destinationIdFor,
  findDestinationDoc,
  intOf,
  isoOf,
  MigrationImportError,
  money,
  num,
  plainText,
  processPages,
  provenance,
  recordDisposition,
  rendered,
  str,
  strOrNull,
  updateDestinationDoc,
  upsertDestination,
  type Ctx,
  type Loose,
} from './context'
import { wordpressContentToLexical } from './gutenberg'
import { redactRawPayload } from './redact'
import {
  recordMigrationError,
  recordMigrationEvent,
  resolveMigrationErrors,
  sourceRecordIdOf,
  upsertMigrationRecord,
} from './records'
import type { MigrationCounts, RawRecord, RecordDisposition } from './types'

/**
 * Resource importers (issue #166 steps 3–4), in dependency order:
 * definitions → terms (parent-first) → media → entries/products → customers
 * → coupons → orders → current stock. Each one streams through
 * `processPages`, so checkpointing, pause/cancel and per-record ledger
 * errors behave identically everywhere; what differs per resource is only
 * the field mapping in its handler.
 */

const INTERNAL_TAXONOMIES = new Set(['link_category', 'nav_menu', 'product_type', 'product_visibility'])
const SUPPORTED_MEDIA = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
])

const dispositionFor = (ctx: Ctx, resource: string): string | undefined =>
  ctx.coverage.find((row) => row.resource === resource)?.disposition

const throwIfCoverageBlocked = (ctx: Ctx, resource: string): void => {
  if (dispositionFor(ctx, resource) === 'unsupported-blocking') {
    throw new MigrationImportError(
      'COVERAGE_BLOCKED',
      'این بخش در ماتریس پوشش پشتیبانی‌نشده و مسدودکننده است؛ داده‌اش وارد نمی‌شود تا تکلیفش روشن شود.',
      'blocked',
    )
  }
}

const actionDisposition = (action: 'created' | 'unchanged' | 'updated'): RecordDisposition =>
  action === 'created' ? 'imported' : action

export const wpTypePath = (type: DiscoveredPostType): null | string =>
  type.restBase ? `/wp-json/${type.restNamespace || 'wp/v2'}/${type.restBase}` : null

export const wpTaxonomyPath = (taxonomy: DiscoveredTaxonomy): null | string =>
  taxonomy.restBase ? `/wp-json/wp/v2/${taxonomy.restBase}` : null

const modifiedParams = (ctx: Ctx): Record<string, string> =>
  ctx.modifiedAfter ? { modified_after: ctx.modifiedAfter } : {}

const findByFields = async (
  ctx: Ctx,
  collection: string,
  fields: Record<string, string>,
): Promise<Loose | null> => {
  const { docs } = await ctx.req.payload.find({
    collection: collection as never,
    depth: 0,
    draft: true,
    limit: 1,
    locale: ctx.settings.locale as never,
    overrideAccess: true,
    req: ctx.req,
    where: {
      and: [
        { site: { equals: ctx.siteId } },
        ...Object.entries(fields).map(([field, value]) => ({ [field]: { equals: value } })),
      ],
    } as never,
  })

  return (docs[0] as Loose | undefined) ?? null
}

const refreshRecordDestination = async (
  ctx: Ctx,
  resource: string,
  sourceRecordId: string,
  updatedAt: null | string,
): Promise<void> => {
  const { docs } = await ctx.req.payload.find({
    collection: 'migration-records',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req: ctx.req,
    where: {
      and: [
        { site: { equals: ctx.siteId } },
        { source: { equals: ctx.sourceId } },
        { resource: { equals: resource } },
        { sourceRecordId: { equals: sourceRecordId } },
      ],
    },
  })
  const record = docs[0]

  if (record) {
    await ctx.req.payload.update({
      id: record.id,
      collection: 'migration-records',
      data: { destinationUpdatedAt: updatedAt } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })
  }
}

/** Wire parents after every row of a hierarchy exists (parents may arrive after children). */
export const linkPendingParents = async (ctx: Ctx, resource: string): Promise<void> => {
  const pending = ctx.pendingParents.filter((item) => item.resource === resource)
  ctx.pendingParents = ctx.pendingParents.filter((item) => item.resource !== resource)

  for (const item of pending) {
    const parentId = await destinationIdFor(ctx, {
      collection: item.collection,
      resource: item.parentResource,
      sourceRecordId: item.parentSourceRecordId,
    })

    if (!parentId) {
      await recordMigrationError(ctx.req, {
        code: 'MISSING_PARENT',
        error: new Error(`والد مبدأ ${item.parentSourceRecordId} برای «${resource}» در مقصد نیست.`),
        jobId: ctx.jobId,
        resource,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId: item.sourceRecordId,
      })
      ctx.counts.errors += 1
      continue
    }

    const updated = await updateDestinationDoc(ctx, {
      collection: item.collection,
      data: { parent: parentId },
      id: item.destinationId,
    })
    await refreshRecordDestination(ctx, resource, item.sourceRecordId, isoOf(updated.updatedAt) || null)
  }
}

// --- Custom fields -----------------------------------------------------------

const KNOWN_INTERNAL_META = new Set([
  '_edit_last',
  '_edit_lock',
  '_encloseme',
  '_pingme',
  '_thumbnail_id',
  '_wp_old_date',
  '_wp_old_slug',
  '_wp_page_template',
])

/** ACF + public postmeta of one entry, as candidate typed field values. */
export const customValuesOf = (raw: RawRecord): Loose => {
  const out: Loose = {}

  for (const [key, value] of Object.entries(asRecord(raw.meta))) {
    if (!key.startsWith('_') && !KNOWN_INTERNAL_META.has(key)) out[key] = value
  }
  for (const [key, value] of Object.entries(asRecord(raw.acf))) out[key] = value

  return out
}

const humanizeKey = (key: string): string =>
  key.replace(/[_-]+/g, ' ').replace(/^\w/, (char) => char.toUpperCase())

/**
 * Infer a typed field schema from sampled records. Inference is a proposal
 * the dry-run shows in `migration-mappings`; a key whose values disagree, or
 * whose name is not a machine key, stays out of the schema and survives in
 * `unmappedMeta` instead of being coerced into a shape it is not.
 */
export const inferFieldSchema = (samples: RawRecord[]): Loose[] => {
  const valuesByKey = new Map<string, unknown[]>()

  for (const sample of samples) {
    for (const [key, value] of Object.entries(customValuesOf(sample))) {
      if (value === null || value === undefined || value === '') continue
      valuesByKey.set(key, [...(valuesByKey.get(key) ?? []), value])
    }
  }

  const rows: Loose[] = []

  for (const [key, values] of [...valuesByKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isMachineKey(key)) continue

    let fieldType = 'json'

    if (values.every((value) => typeof value === 'boolean')) fieldType = 'boolean'
    else if (values.every((value) => typeof value === 'number')) fieldType = 'number'
    else if (values.every((value) => typeof value === 'string')) {
      const strings = values as string[]
      if (strings.every((value) => Number.isFinite(Date.parse(value)) && /\d{4}-\d{2}-\d{2}/.test(value))) {
        fieldType = 'date'
      } else if (strings.every((value) => /^https?:\/\//i.test(value))) fieldType = 'url'
      else if (strings.some((value) => value.length > 240 || value.includes('\n'))) fieldType = 'textarea'
      else fieldType = 'text'
    }

    rows.push({
      fieldType,
      key,
      label: humanizeKey(key),
      required: false,
      searchable: fieldType === 'text' || fieldType === 'number',
    })
  }

  return rows
}

// --- Definitions -------------------------------------------------------------

export const importDefinitions = async (ctx: Ctx): Promise<void> => {
  const inventory = ctx.inventory
  if (!inventory) return

  for (const taxonomy of inventory.taxonomies) {
    if (taxonomy.slug === 'category' || INTERNAL_TAXONOMIES.has(taxonomy.slug)) continue

    ctx.counts.seen += 1
    try {
      if (!isMachineKey(taxonomy.slug)) {
        throw new MigrationImportError(
          'BAD_TAXONOMY_KEY',
          `کلید طبقه‌بندی «${taxonomy.slug}» ماشینی نیست و به تعریف مقصد تبدیل نمی‌شود.`,
          'blocked',
        )
      }
      const raw = taxonomy as unknown as RawRecord
      const existing = await findByFields(ctx, 'taxonomy-definitions', { key: taxonomy.slug })
      const result = await upsertDestination(ctx, {
        ...(existing ? { adoptId: String(existing.id) } : {}),
        collection: 'taxonomy-definitions',
        data: {
          archiveSlug: slugify(taxonomy.slug),
          hasArchive: true,
          hierarchical: taxonomy.hierarchical,
          key: taxonomy.slug,
          pluralLabel: taxonomy.name,
          singularLabel: taxonomy.name,
          ...provenance(ctx, {
            raw,
            sourceRecordId: taxonomy.slug,
            sourceType: 'taxonomy',
            system: 'wordpress',
          }),
        },
        raw,
        resource: 'taxonomy-definition',
        sourceRecordId: taxonomy.slug,
      })
      ctx.taxonomyDefinitions.set(taxonomy.slug, result.doc)
      ctx.counts[actionDisposition(result.action) === 'unchanged' ? 'unchanged' : result.action === 'created' ? 'imported' : 'updated'] += 1
    } catch (error) {
      ctx.counts.errors += 1
      await recordDisposition(ctx, {
        disposition: error instanceof MigrationImportError && error.disposition === 'blocked' ? 'blocked' : 'error',
        raw: taxonomy as unknown as RawRecord,
        resource: 'taxonomy-definition',
        sourceRecordId: taxonomy.slug,
      }).catch(() => undefined)
      await recordMigrationError(ctx.req, {
        code: error instanceof MigrationImportError ? error.code : 'DEFINITION_ERROR',
        error,
        jobId: ctx.jobId,
        resource: 'taxonomy-definition',
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId: taxonomy.slug,
      })
    }
  }

  for (const type of inventory.postTypes) {
    if (type.capability !== 'custom') continue

    ctx.counts.seen += 1
    const resource = `post-type:${type.slug}`

    try {
      throwIfCoverageBlocked(ctx, resource)
      if (classifyCptCapability(type).mode === 'requires-review') {
        throw new MigrationImportError(
          'CPT_REQUIRES_REVIEW',
          'این گونه محتوا نشانه فرایند عملیاتی دارد و تا تأیید تطبیق‌دهنده وارد نمی‌شود.',
          'blocked',
        )
      }
      if (!isMachineKey(type.slug)) {
        throw new MigrationImportError(
          'BAD_TYPE_KEY',
          `کلید گونه محتوای «${type.slug}» ماشینی نیست.`,
          'blocked',
        )
      }

      const path = wpTypePath(type)
      let inferred: Loose[] = []

      if (path) {
        for await (const { items } of ctx.clients.wp.pages<RawRecord>(path, {
          context: 'edit',
          status: 'any',
        })) {
          inferred = inferFieldSchema(items)
          break
        }
      }

      const existing = await findByFields(ctx, 'content-type-definitions', { key: type.slug })
      const existingSchema = asArray(existing?.fieldSchema) as Loose[]
      const existingKeys = new Set(existingSchema.map((field) => str(field.key)))
      const fieldSchema = [
        ...existingSchema,
        ...inferred.filter((field) => !existingKeys.has(str(field.key))),
      ]
      const archiveSlug =
        typeof type.hasArchive === 'string' && isValidArchiveSlug(type.hasArchive)
          ? type.hasArchive
          : slugify(type.slug)
      const raw = type as unknown as RawRecord
      const result = await upsertDestination(ctx, {
        ...(existing ? { adoptId: String(existing.id) } : {}),
        collection: 'content-type-definitions',
        data: {
          archiveSlug,
          fieldSchema,
          hasArchive: type.hasArchive !== false,
          hierarchical: type.hierarchical,
          key: type.slug,
          permalinkTemplate: '/{archive}/{slug}',
          pluralLabel: type.name,
          singularLabel: type.name,
          taxonomies: type.taxonomies.flatMap((slug) => {
            const definition = ctx.taxonomyDefinitions.get(slug)
            return definition ? [String(definition.id)] : []
          }),
          ...provenance(ctx, {
            raw,
            sourceRecordId: type.slug,
            sourceType: 'post_type',
            system: 'wordpress',
          }),
        },
        raw,
        resource: 'content-type-definition',
        sourceRecordId: type.slug,
      })
      ctx.typeDefinitions.set(type.slug, result.doc)
      ctx.counts[result.action === 'created' ? 'imported' : result.action] += 1

      for (const field of inferred) {
        await ctx.req.payload
          .create({
            collection: 'migration-mappings',
            data: {
              destination: `content-type-definitions(${type.slug}).fieldSchema.${str(field.key)}:${str(field.fieldType)}`,
              disposition: 'requires-mapping',
              job: ctx.jobId,
              resource,
              site: ctx.siteId,
              source: ctx.sourceId,
              sourceField: str(field.key),
              status: 'proposed',
              transform: { inferredFromSamples: true },
            } as never,
            depth: 0,
            overrideAccess: true,
            req: ctx.req,
          })
          .catch(() => undefined)
      }
    } catch (error) {
      const blocked = error instanceof MigrationImportError && error.disposition === 'blocked'
      ctx.counts[blocked ? 'blocked' : 'errors'] += 1
      await recordDisposition(ctx, {
        disposition: blocked ? 'blocked' : 'error',
        raw: type as unknown as RawRecord,
        resource: 'content-type-definition',
        sourceRecordId: type.slug,
      }).catch(() => undefined)
      await recordMigrationError(ctx.req, {
        code: error instanceof MigrationImportError ? error.code : 'DEFINITION_ERROR',
        error,
        jobId: ctx.jobId,
        resource,
        retryable: !blocked,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId: type.slug,
      })
    }
  }
}

// --- Terms -------------------------------------------------------------------

export const importTerms = async (ctx: Ctx): Promise<void> => {
  const inventory = ctx.inventory
  if (!inventory) return

  for (const taxonomy of inventory.taxonomies) {
    if (INTERNAL_TAXONOMIES.has(taxonomy.slug)) continue
    const path = wpTaxonomyPath(taxonomy)
    if (!path) continue

    const resource = `taxonomy:${taxonomy.slug}`
    const isCategory = taxonomy.slug === 'category'
    const collection = isCategory ? 'categories' : 'taxonomy-terms'

    await processPages(ctx, {
      client: ctx.clients.wp,
      handler: async (raw) => {
        const sourceRecordId = sourceRecordIdOf(raw)!
        const slug = preserveWordPressSlug(raw.slug)
        const name = plainText(raw.name) || slug
        const data: Loose = isCategory
          ? { parent: null, slug, title: name }
          : {
              description: plainText(raw.description),
              legacyArchiveUrl: str(raw.link) || null,
              meta: raw.meta ? redactRawPayload(raw.meta) : null,
              name,
              parent: null,
              slug,
              sourceTermTaxonomyId: raw.term_taxonomy_id ? String(raw.term_taxonomy_id) : null,
              taxonomy: String(ctx.taxonomyDefinitions.get(taxonomy.slug)?.id ?? ''),
            }

        if (!isCategory && !data.taxonomy) {
          throw new MigrationImportError(
            'MISSING_TAXONOMY_DEFINITION',
            `تعریف طبقه‌بندی «${taxonomy.slug}» در مقصد ساخته نشد.`,
            'blocked',
          )
        }

        Object.assign(
          data,
          provenance(ctx, {
            raw,
            sourceRecordId,
            sourceType: taxonomy.slug,
            system: 'wordpress',
          }),
        )

        const result = await upsertDestination(ctx, {
          collection,
          data,
          metadata: { sourceParentId: intOf(raw.parent, 0) },
          raw,
          resource,
          sourceRecordId,
        })

        const parent = intOf(raw.parent, 0)
        if (parent > 0) {
          ctx.pendingParents.push({
            collection,
            destinationId: result.id,
            parentResource: resource,
            parentSourceRecordId: String(parent),
            resource,
            sourceRecordId,
          })
        }

        return actionDisposition(result.action)
      },
      params: { context: 'edit', hide_empty: 'false', order: 'asc', orderby: 'id' },
      path,
      resource,
    })
    await linkPendingParents(ctx, resource)
  }
}

// --- Media -------------------------------------------------------------------

export const mediaDestination = async (
  ctx: Ctx,
  sourceRecordId: number | string | null | undefined,
): Promise<null | string> => {
  if (sourceRecordId === null || sourceRecordId === undefined || sourceRecordId === 0) return null

  return destinationIdFor(ctx, {
    collection: 'media',
    resource: 'media',
    sourceRecordId,
  })
}

export const mediaDestinationByUrl = async (
  ctx: Ctx,
  url: null | string | undefined,
): Promise<null | string> => {
  if (!url) return null
  const cached = ctx.mediaByUrl.get(url)
  if (cached) return cached

  let filename = ''
  try {
    filename = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    return null
  }
  if (!filename) return null

  const doc = await findByFields(ctx, 'media', { filename })
  const id = doc ? String(doc.id) : null
  if (id) ctx.mediaByUrl.set(url, id)

  return id
}

const safeFilename = (url: string, fallback: string): string => {
  try {
    const raw = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    const clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim()
    return clean || fallback
  } catch {
    return fallback
  }
}

export const importMedia = async (ctx: Ctx): Promise<void> => {
  if (!ctx.settings.includeMedia) return

  await processPages(ctx, {
    client: ctx.clients.wp,
    handler: async (raw) => {
      const sourceRecordId = sourceRecordIdOf(raw)!
      const mime = str(raw.mime_type)

      if (!SUPPORTED_MEDIA.has(mime)) {
        throw new MigrationImportError(
          'UNSUPPORTED_MEDIA',
          `گونه پرونده «${mime || 'نامشخص'}» در کتابخانه رسانه ای‌شوب جا نمی‌شود و برای بازبینی دستی مسدود ماند.`,
          'blocked',
        )
      }

      const sourceUrl = str(raw.source_url)
      if (!sourceUrl) {
        throw new MigrationImportError('MISSING_MEDIA_URL', 'پیوست نشانی پرونده (source_url) ندارد.')
      }

      const data: Loose = {
        alt: plainText(raw.alt_text) || plainText(raw.title),
        ...provenance(ctx, {
          raw,
          sourceRecordId,
          sourceType: 'attachment',
          system: 'wordpress',
        }),
      }

      const caption = plainText(raw.caption)
      if (caption) {
        data.caption = wordpressContentToLexical(caption, { locale: ctx.settings.locale }).lexical
      }

      // Skip the download entirely when the ledger already proves this exact
      // attachment is in place; `upsertDestination` re-checks the hash.
      const existingId = await destinationIdFor(ctx, {
        collection: 'media',
        resource: 'media',
        sourceRecordId,
      })
      const unchangedCheck = existingId
        ? await upsertDestination(ctx, {
            collection: 'media',
            data,
            metadata: { mimeType: mime, sourceUrl },
            raw,
            resource: 'media',
            sourceRecordId,
          })
        : null

      if (unchangedCheck?.action === 'unchanged') {
        ctx.mediaByUrl.set(sourceUrl, unchangedCheck.id)
        return 'unchanged'
      }

      const file = await ctx.download(sourceUrl)
      const result = await upsertDestination(ctx, {
        collection: 'media',
        data,
        file: { ...file, name: file.name || safeFilename(sourceUrl, `media-${sourceRecordId}`) },
        metadata: { mimeType: mime, sourceUrl },
        raw,
        resource: 'media',
        sourceRecordId,
      })
      ctx.mediaByUrl.set(sourceUrl, result.id)

      return actionDisposition(result.action)
    },
    params: { context: 'edit', order: 'asc', orderby: 'id', ...modifiedParams(ctx) },
    path: '/wp-json/wp/v2/media',
    resource: 'media',
  })
}

// --- SEO ----------------------------------------------------------------------

const metaFirst = (raw: RawRecord, keys: string[]): null | string => {
  const meta = asRecord(raw.meta)

  for (const key of keys) {
    const value = meta[key] ?? raw[key]
    const text = Array.isArray(value) ? str(value[0]) : str(value)
    if (text.trim()) return text.trim()
  }

  return null
}

export const seoOf = (
  raw: RawRecord,
): { canonical: null | string; description: null | string; noindex: boolean; ogImageUrl: null | string; title: null | string } => {
  const yoast = asRecord(raw.yoast_head_json)
  const robots = asRecord(yoast.robots)
  const ogImages = asArray(yoast.og_image)
  const ogFirst = asRecord(ogImages[0])

  return {
    canonical:
      strOrNull(yoast.canonical) ??
      metaFirst(raw, ['_yoast_wpseo_canonical', 'rank_math_canonical_url']),
    description:
      strOrNull(yoast.description) ??
      metaFirst(raw, ['_yoast_wpseo_metadesc', 'rank_math_description']),
    noindex:
      str(robots.index).toLowerCase() === 'noindex' ||
      metaFirst(raw, ['_yoast_wpseo_meta-robots-noindex']) === '1' ||
      str(metaFirst(raw, ['rank_math_robots'])).includes('noindex'),
    ogImageUrl: strOrNull(ogFirst.url) ?? metaFirst(raw, ['_yoast_wpseo_opengraph-image']),
    title: strOrNull(yoast.title) ?? metaFirst(raw, ['_yoast_wpseo_title', 'rank_math_title']),
  }
}

// --- Content -----------------------------------------------------------------

const dateOf = (raw: RawRecord): string => {
  const candidate = str(raw.date_gmt) || str(raw.date)
  const time = Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(candidate) ? candidate : `${candidate}Z`)

  return Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString()
}

const termDestinationIds = async (
  ctx: Ctx,
  taxonomy: DiscoveredTaxonomy,
  raw: RawRecord,
): Promise<string[]> => {
  const values = asArray(raw[taxonomy.slug] ?? (taxonomy.restBase ? raw[taxonomy.restBase] : undefined))
  const ids: string[] = []

  for (const value of values) {
    const id = await destinationIdFor(ctx, {
      collection: taxonomy.slug === 'category' ? 'categories' : 'taxonomy-terms',
      resource: `taxonomy:${taxonomy.slug}`,
      sourceRecordId: value as number | string,
    })
    if (id) ids.push(id)
  }

  return ids
}

const relationResourceFor = (collection: string): null | string => {
  switch (collection) {
    case 'content-entries':
      return 'relation-target:content-entries'
    case 'posts':
      return 'post-type:post'
    case 'pages':
      return 'post-type:page'
    case 'products':
      return 'product'
    case 'media':
      return 'media'
    case 'categories':
      return 'taxonomy:category'
    case 'taxonomy-terms':
      return 'relation-target:taxonomy-terms'
    default:
      return null
  }
}

/** Source identifiers out of an ACF relationship value (ids, WP_Post-shaped objects, nested rows). */
export const sourceIdsFromRelationValue = (value: unknown, depth = 0): string[] => {
  if (depth > 3 || value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((item) => sourceIdsFromRelationValue(item, depth + 1))
  if (typeof value === 'number' || typeof value === 'string') {
    const text = String(value).trim()
    return text ? [text] : []
  }
  if (typeof value === 'object') {
    const record = asRecord(value)
    for (const key of ['ID', 'id', 'value']) {
      const ids = sourceIdsFromRelationValue(record[key], depth + 1)
      if (ids.length) return ids
    }
  }
  return []
}

/**
 * The exact synthetic source rows edge imports hash into the ledger.
 * Reconciliation rebuilds these from a fresh source scan, so both sides must
 * construct them through the same helpers rather than merely similar code.
 */
export const entryTermRelationRaw = (
  sourceEntryRecordId: string,
  taxonomySlug: string,
  termSourceId: unknown,
): RawRecord => ({
  entry: sourceEntryRecordId,
  id: `${sourceEntryRecordId}:${taxonomySlug}:${String(termSourceId)}`,
  taxonomy: taxonomySlug,
  term: termSourceId,
})

export const acfContentRelationRaw = (
  sourceEntryRecordId: string,
  fieldKey: string,
  relationTo: string,
  targetSourceId: string,
): RawRecord => ({
  entry: sourceEntryRecordId,
  field: fieldKey,
  id: `${sourceEntryRecordId}:${fieldKey}:${targetSourceId}`,
  relationTo,
  target: targetSourceId,
})

type ResolvedRelationValue = {
  pairs: { destinationId: string; sourceId: string }[]
  unresolved: string[]
}

const resolveRelationValue = async (
  ctx: Ctx,
  collection: string,
  value: unknown,
): Promise<ResolvedRelationValue> => {
  const resource = relationResourceFor(collection)
  const sourceIds = [...new Set(sourceIdsFromRelationValue(value))]
  const pairs: ResolvedRelationValue['pairs'] = []
  const unresolved: string[] = []

  if (!resource) return { pairs, unresolved: sourceIds }

  for (const sourceId of sourceIds) {
    const destinationId = await destinationIdFor(ctx, {
      collection,
      resource,
      sourceRecordId: sourceId,
    })
    if (destinationId) pairs.push({ destinationId, sourceId })
    else unresolved.push(sourceId)
  }

  return { pairs, unresolved }
}

export const relationshipFieldSupported = (field: Loose): boolean =>
  (CUSTOM_FIELD_RELATION_COLLECTIONS as readonly string[]).includes(str(field.relationTo))

const coerceFieldValues = async (
  ctx: Ctx,
  definition: Loose,
  raw: RawRecord,
): Promise<{ fieldValues: Loose; unmapped: Loose }> => {
  const schema = asArray(definition.fieldSchema) as Loose[]
  const byKey = new Map(schema.map((field) => [str(field.key), field]))
  const fieldValues: Loose = {}
  const unmapped: Loose = {}

  for (const [key, value] of Object.entries(customValuesOf(raw))) {
    const field = byKey.get(key)

    if (!field) {
      fieldValues[key] = redactRawPayload(value)
      continue
    }

    const type = str(field.fieldType)

    if (type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      fieldValues[key] = Number(value)
    } else if (type === 'boolean') {
      fieldValues[key] = value === true || value === 'true' || value === '1' || value === 1
    } else if (type === 'media') {
      const id = await mediaDestination(ctx, value as number | string)
      if (id) fieldValues[key] = id
      else unmapped[key] = redactRawPayload(value)
    } else if (type === 'gallery') {
      const ids: string[] = []
      for (const item of asArray(value)) {
        const id = await mediaDestination(ctx, item as number | string)
        if (id) ids.push(id)
      }
      if (ids.length) fieldValues[key] = ids
      else unmapped[key] = redactRawPayload(value)
    } else if (type === 'relationship') {
      const relationTo = str(field.relationTo)
      const sourceIds = sourceIdsFromRelationValue(value)

      if (relationTo !== 'media' || ctx.settings.includeMedia) {
        if (relationshipFieldSupported(field) && sourceIds.length) {
          const resolved = await resolveRelationValue(ctx, relationTo, value)
          const ids = resolved.pairs.map((pair) => pair.destinationId)

          // The destination collection is explicit schema, never inferred
          // from a bare numeric id. A partially resolvable value stays wholly
          // in unmappedMeta until the post-import pass can finish it, so the
          // native field never claims a relation it silently truncated.
          if (resolved.unresolved.length === 0) {
            fieldValues[key] = Array.isArray(value) ? ids : ids[0]
          } else {
            unmapped[key] = redactRawPayload(value)
          }
        } else {
          unmapped[key] = redactRawPayload(value)
        }
      } else {
        unmapped[key] = redactRawPayload(value)
      }
    } else {
      fieldValues[key] = redactRawPayload(value)
    }
  }

  return { fieldValues, unmapped }
}

export const importContent = async (ctx: Ctx): Promise<void> => {
  const inventory = ctx.inventory
  if (!inventory || !ctx.settings.includeContent) return

  for (const type of inventory.postTypes) {
    if (!['core-page', 'core-post', 'custom'].includes(type.capability)) continue
    const path = wpTypePath(type)
    if (!path) continue

    const resource = `post-type:${type.slug}`
    const attachedTaxonomies = inventory.taxonomies.filter(
      (taxonomy) => type.taxonomies.includes(taxonomy.slug) && !INTERNAL_TAXONOMIES.has(taxonomy.slug),
    )

    await processPages(ctx, {
      client: ctx.clients.wp,
      handler: async (raw) => {
        throwIfCoverageBlocked(ctx, resource)
        const sourceRecordId = sourceRecordIdOf(raw)!
        const status = mapWordPressStatus(str(raw.status) || 'draft')

        if (status.disposition === 'archive-only') {
          return recordDisposition(ctx, {
            disposition: 'archived',
            raw,
            resource,
            sourceRecordId,
          })
        }

        const slug = preserveWordPressSlug(raw.slug)
        const title = plainText(raw.title) || slug
        const contentRecord = asRecord(raw.content)
        const sourceHtml = str(contentRecord.raw) || rendered(raw.content)
        const conversion = wordpressContentToLexical(sourceHtml, { locale: ctx.settings.locale })
        const seo = seoOf(raw)
        const heroImage = await mediaDestination(ctx, raw.featured_media as number | string)
        const ogImage = seo.ogImageUrl ? await mediaDestinationByUrl(ctx, seo.ogImageUrl) : null
        const published = status.target === 'published' || status.target === 'scheduled'
        const commonProvenance = provenance(ctx, {
          raw,
          sourceRecordId,
          sourceType: type.slug,
          system: 'wordpress',
        })
        const metadata = {
          conversionWarnings: conversion.warnings,
          sourceParentId: intOf(raw.parent, 0),
          unsupportedBlocks: conversion.unsupportedBlocks,
        }

        if (type.capability === 'core-post') {
          const categories = await termDestinationIds(
            ctx,
            attachedTaxonomies.find((taxonomy) => taxonomy.slug === 'category') ??
              ({ restBase: 'categories', slug: 'category' } as DiscoveredTaxonomy),
            { ...raw, category: raw.categories },
          ).catch(() => [])
          const taxonomyTerms: string[] = []

          for (const taxonomy of attachedTaxonomies) {
            if (taxonomy.slug === 'category') continue
            taxonomyTerms.push(...(await termDestinationIds(ctx, taxonomy, raw)))
          }

          const result = await upsertDestination(ctx, {
            collection: 'posts',
            data: {
              _status: published ? 'published' : 'draft',
              categories,
              content: conversion.lexical,
              ...(heroImage ? { heroImage } : {}),
              meta: {
                ...(seo.description ? { description: seo.description } : {}),
                ...(ogImage ? { image: ogImage } : {}),
                ...(seo.title ? { title: seo.title } : {}),
              },
              publishedAt: dateOf(raw),
              slug,
              taxonomyTerms,
              title,
              ...commonProvenance,
            },
            metadata,
            raw,
            resource,
            sourceRecordId,
          })

          return actionDisposition(result.action)
        }

        if (type.capability === 'core-page') {
          const result = await upsertDestination(ctx, {
            collection: 'pages',
            data: {
              _status: published ? 'published' : 'draft',
              hero: { type: 'none' },
              layout: [
                {
                  blockType: 'content',
                  columns: [{ richText: conversion.lexical, size: 'full' }],
                },
              ],
              meta: {
                ...(seo.description ? { description: seo.description } : {}),
                ...(ogImage ? { image: ogImage } : {}),
                ...(seo.title ? { title: seo.title } : {}),
              },
              parent: null,
              publishedAt: dateOf(raw),
              slug,
              title,
              ...commonProvenance,
            },
            metadata,
            raw,
            resource,
            sourceRecordId,
          })

          if (intOf(raw.parent, 0) > 0) {
            ctx.pendingParents.push({
              collection: 'pages',
              destinationId: result.id,
              parentResource: resource,
              parentSourceRecordId: String(raw.parent),
              resource,
              sourceRecordId,
            })
          }

          return actionDisposition(result.action)
        }

        const definition = ctx.typeDefinitions.get(type.slug)

        if (!definition) {
          throw new MigrationImportError(
            'MISSING_TYPE_DEFINITION',
            `تعریف گونه «${type.slug}» در مقصد نیست؛ رکورد بدون گونه وارد نمی‌شود.`,
            'blocked',
          )
        }

        const { fieldValues, unmapped } = await coerceFieldValues(ctx, definition, raw)
        const galleryIds: string[] = []

        for (const key of ['gallery', 'gallery_ids']) {
          for (const item of asArray(customValuesOf(raw)[key])) {
            const id = await mediaDestination(ctx, item as number | string)
            if (id) galleryIds.push(id)
          }
        }

        const needsArchive =
          conversion.unsupportedBlocks.length > 0 ||
          conversion.warnings.length > 0 ||
          Boolean(asRecord(raw.meta)._elementor_edit_mode)
        const result = await upsertDestination(ctx, {
          collection: 'content-entries',
          data: {
            authorName: str(asRecord(asArray(asRecord(raw._embedded).author)[0]).name) || null,
            body: conversion.lexical,
            ...(seo.canonical ? { canonicalUrl: seo.canonical } : {}),
            contentType: String(definition.id),
            excerpt: plainText(raw.excerpt),
            fieldValues,
            gallery: galleryIds,
            ...(heroImage ? { heroImage } : {}),
            menuOrder: intOf(raw.menu_order, 0),
            ...(seo.description ? { metaDescription: seo.description } : {}),
            ...(seo.title ? { metaTitle: seo.title } : {}),
            noindex: seo.noindex,
            ...(ogImage ? { ogImage } : {}),
            parent: null,
            ...(needsArchive ? { preservedHtml: sourceHtml } : {}),
            publishedAt: dateOf(raw),
            slug,
            status: status.target ?? 'draft',
            title,
            unmappedMeta: unmapped,
            ...commonProvenance,
          },
          metadata,
          raw,
          resource,
          sourceRecordId,
        })

        const parent = intOf(raw.parent, 0)
        if (parent > 0 && type.hierarchical) {
          ctx.pendingParents.push({
            collection: 'content-entries',
            destinationId: result.id,
            parentResource: resource,
            parentSourceRecordId: String(parent),
            resource,
            sourceRecordId,
          })
        }

        // Every explicitly declared relationship field is queued even when
        // the source value is now empty: the late pass both creates the
        // current edges and retires edges a delta sync removed.
        for (const field of asArray(definition.fieldSchema) as Loose[]) {
          if (str(field.fieldType) !== 'relationship' || !relationshipFieldSupported(field)) continue
          ctx.pendingContentRelations.push({
            entryId: result.id,
            fieldKey: str(field.key),
            relationTo: str(field.relationTo),
            sourceEntryRecordId: sourceRecordId,
            sourceType: type.slug,
            value: redactRawPayload(customValuesOf(raw)[str(field.key)] ?? null),
          })
        }

        for (const taxonomy of attachedTaxonomies) {
          if (taxonomy.slug === 'category') continue
          const definitionDoc = ctx.taxonomyDefinitions.get(taxonomy.slug)
          if (!definitionDoc) continue
          const sourceTermIds = asArray(
            raw[taxonomy.slug] ?? (taxonomy.restBase ? raw[taxonomy.restBase] : undefined),
          )

          for (const [index, termSourceId] of sourceTermIds.entries()) {
            const termId = await destinationIdFor(ctx, {
              collection: 'taxonomy-terms',
              resource: `taxonomy:${taxonomy.slug}`,
              sourceRecordId: termSourceId as number | string,
            })
            const relRaw = entryTermRelationRaw(sourceRecordId, taxonomy.slug, termSourceId)
            const syntheticId = String(relRaw.id)

            if (!termId) {
              await recordMigrationError(ctx.req, {
                code: 'MISSING_TERM',
                error: new Error(`واژه مبدأ ${String(termSourceId)} از «${taxonomy.slug}» در مقصد نیست.`),
                jobId: ctx.jobId,
                resource: 'entry-term',
                siteId: ctx.siteId,
                sourceId: ctx.sourceId,
                sourceRecordId: syntheticId,
              })
              continue
            }

            await upsertDestination(ctx, {
              collection: 'entry-term-relations',
              data: {
                entry: result.id,
                menuOrder: index,
                taxonomy: String(definitionDoc.id),
                term: termId,
                ...provenance(ctx, {
                  raw: relRaw,
                  sourceRecordId: syntheticId,
                  sourceType: 'term_relationship',
                  system: 'wordpress',
                }),
              },
              raw: relRaw,
              resource: 'entry-term',
              sourceRecordId: syntheticId,
            }).catch(async (error: unknown) => {
              await recordMigrationError(ctx.req, {
                code: 'ENTRY_TERM_ERROR',
                error,
                jobId: ctx.jobId,
                resource: 'entry-term',
                siteId: ctx.siteId,
                sourceId: ctx.sourceId,
                sourceRecordId: syntheticId,
              })
            })
          }
        }

        return actionDisposition(result.action)
      },
      params: { context: 'edit', order: 'asc', orderby: 'id', status: 'any', ...modifiedParams(ctx) },
      path,
      resource,
    })
    await linkPendingParents(ctx, resource)
  }
}

// --- Woo helpers ---------------------------------------------------------------

export const wooClientOrBlock = (ctx: Ctx) => {
  if (!ctx.clients.woo) {
    throw new MigrationImportError(
      'WOO_CREDENTIALS_MISSING',
      'برای داده‌های فروشگاه، اعتبارنامه فقط‌خواندنی ووکامرس لازم است.',
      'blocked',
    )
  }

  return ctx.clients.woo
}

const addressOf = (value: unknown): Loose => {
  const raw = asRecord(value)

  return {
    address1: str(raw.address_1),
    address2: str(raw.address_2),
    city: str(raw.city),
    company: str(raw.company),
    country: str(raw.country),
    email: str(raw.email),
    firstName: str(raw.first_name),
    lastName: str(raw.last_name),
    phone: str(raw.phone),
    postcode: str(raw.postcode),
    state: str(raw.state),
  }
}

// --- Products ------------------------------------------------------------------

export const variationRows = async (ctx: Ctx, product: RawRecord): Promise<RawRecord[]> => {
  if (str(product.type) !== 'variable') return []

  return ctx.clients.woo
    ? ((await ctx.clients.woo.collect(`/wp-json/wc/v3/products/${String(product.id)}/variations`, {
        status: 'any',
      })) as RawRecord[])
    : []
}

export const importProducts = async (ctx: Ctx): Promise<void> => {
  if (!ctx.inventory?.hasWooCommerce || !ctx.settings.includeProducts) return
  if (!commerceAllowed(ctx)) {
    await recordMigrationEvent(ctx.req, {
      eventType: 'commerce.skipped-non-store',
      jobId: ctx.jobId,
      level: 'warning',
      message: 'محصولات روی سایت غیرفروشگاهی وارد نشدند؛ مهاجرت فروشگاه باید روی سایت فروشگاهی اجرا شود.',
      resource: 'product',
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
    })
    return
  }

  const woo = wooClientOrBlock(ctx)

  await processPages(ctx, {
    client: woo,
    handler: async (raw) => {
      throwIfCoverageBlocked(ctx, 'post-type:product')
      const sourceRecordId = sourceRecordIdOf(raw)!
      const type = str(raw.type) || 'simple'

      if (!['external', 'grouped', 'simple', 'variable'].includes(type)) {
        throw new MigrationImportError(
          'UNSUPPORTED_PRODUCT_TYPE',
          `گونه محصول «${type}» معادل بومی ندارد و مسدود ماند.`,
          'blocked',
        )
      }

      const variationsRaw = await variationRows(ctx, raw)
      if (type === 'variable' && variationsRaw.length === 0) {
        throw new MigrationImportError(
          'VARIATIONS_MISSING',
          'محصول متغیر است اما هیچ تنوعی از API برنگشت؛ بدون تنوع وارد نمی‌شود.',
          'blocked',
        )
      }

      const variations: Loose[] = []

      for (const variation of variationsRaw) {
        const price = money(ctx, variation.price || variation.regular_price)
        const regular = money(ctx, variation.regular_price || variation.price)
        const image = await mediaDestination(ctx, asRecord(variation.image).id as number | string)
        const attributeValues: Loose = {}
        const labelParts: string[] = []

        for (const attributeValue of asArray(variation.attributes)) {
          const attribute = asRecord(attributeValue)
          const key = str(attribute.slug) || str(attribute.name)
          if (key) attributeValues[key] = str(attribute.option)
          if (str(attribute.option)) labelParts.push(str(attribute.option))
        }

        variations.push({
          active: str(variation.status) !== 'draft',
          attributeValues,
          ...(regular > price ? { compareAtPrice: regular } : {}),
          ...(image ? { image } : {}),
          key: `source-${String(variation.id)}`,
          label: labelParts.join(' / '),
          price,
          sku: str(variation.sku),
          sourceId: String(variation.id),
          sourceStatus: str(variation.status),
          // Current stock is applied once, after historical orders.
          trackInventory: false,
          weight: str(variation.weight),
        })
      }

      const ownPrice = money(ctx, raw.price || raw.regular_price)
      const regularPrice = money(ctx, raw.regular_price || raw.price)
      const price =
        type === 'variable'
          ? Math.min(...variations.map((variation) => Number(variation.price)))
          : ownPrice
      const imageRecords = asArray(raw.images)
      const imageIds: string[] = []

      for (const image of imageRecords) {
        const record = asRecord(image)
        const id =
          (await mediaDestination(ctx, record.id as number | string)) ??
          (await mediaDestinationByUrl(ctx, str(record.src)))
        if (id) imageIds.push(id)
      }

      const terms: string[] = []

      for (const [field, taxonomy] of [
        ['categories', 'product_cat'],
        ['tags', 'product_tag'],
      ] as const) {
        for (const term of asArray(raw[field])) {
          const id = await destinationIdFor(ctx, {
            collection: 'taxonomy-terms',
            resource: `taxonomy:${taxonomy}`,
            sourceRecordId: asRecord(term).id as number | string,
          })
          if (id) terms.push(id)
        }
      }

      const seo = seoOf(raw)
      const slug = preserveWordPressSlug(raw.slug)
      const hashRaw = { ...raw, __eshobe_variations: variationsRaw }
      const result = await upsertDestination(ctx, {
        collection: 'products',
        contentHash: undefined,
        data: {
          _status: str(raw.status) === 'publish' ? 'published' : 'draft',
          attributes: asArray(raw.attributes).map((attributeValue) => {
            const attribute = asRecord(attributeValue)

            return {
              key: str(attribute.slug) || str(attribute.name),
              name: str(attribute.name),
              options: asArray(attribute.options).map((option) => ({ value: str(option) })),
              usedForVariation: attribute.variation === true,
              visible: attribute.visible !== false,
            }
          }),
          body: wordpressContentToLexical(str(raw.description), { locale: ctx.settings.locale }).lexical,
          ...(str(raw.button_text) ? { buttonText: str(raw.button_text) } : {}),
          ...(seo.canonical ? { canonicalUrl: seo.canonical } : {}),
          ...(regularPrice > price && type !== 'variable' ? { compareAtPrice: regularPrice } : {}),
          downloadable: raw.downloadable === true,
          ...(str(raw.external_url) ? { externalUrl: str(raw.external_url) } : {}),
          gallery: imageIds.slice(1),
          height: str(asRecord(raw.dimensions).height),
          ...(imageIds[0] ? { image: imageIds[0] } : {}),
          length: str(asRecord(raw.dimensions).length),
          ...(seo.description ? { metaDescription: seo.description } : {}),
          ...(seo.title ? { metaTitle: seo.title } : {}),
          noindex: seo.noindex,
          price,
          productType: type,
          sku: str(raw.sku),
          slug,
          summary: plainText(raw.short_description),
          terms,
          title: plainText(raw.name) || slug,
          // Historical orders import next under the migration context; the
          // live count is applied once afterwards (see applyCurrentStock).
          trackInventory: false,
          variations,
          virtual: raw.virtual === true,
          weight: str(raw.weight),
          width: str(asRecord(raw.dimensions).width),
          ...provenance(ctx, {
            raw: hashRaw,
            sourceRecordId,
            sourceType: 'product',
            system: 'woocommerce',
          }),
        },
        metadata: {
          crossSellIds: asArray(raw.cross_sell_ids).map(String),
          groupedIds: asArray(raw.grouped_products).map(String),
          manageStock: raw.manage_stock === true,
          stockQuantity: raw.stock_quantity ?? null,
          upsellIds: asArray(raw.upsell_ids).map(String),
          variationStock: variationsRaw.map((variation) => ({
            key: `source-${String(variation.id)}`,
            manageStock: variation.manage_stock === true || variation.manage_stock === 'parent',
            parentStock: variation.manage_stock === 'parent',
            stockQuantity: variation.stock_quantity ?? null,
          })),
        },
        raw: hashRaw,
        resource: 'product',
        sourceRecordId,
      })

      return actionDisposition(result.action)
    },
    params: { order: 'asc', orderby: 'id', status: 'any', ...modifiedParams(ctx) },
    path: '/wp-json/wc/v3/products',
    resource: 'product',
  })

  await linkProductRelations(ctx)
}

const allProductRecords = async (ctx: Ctx): Promise<Loose[]> => {
  const { docs } = await ctx.req.payload.find({
    collection: 'migration-records',
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    req: ctx.req,
    where: {
      and: [
        { site: { equals: ctx.siteId } },
        { source: { equals: ctx.sourceId } },
        { resource: { equals: 'product' } },
        { destinationId: { exists: true } },
      ],
    },
  })

  return docs as unknown as Loose[]
}

const linkProductRelations = async (ctx: Ctx): Promise<void> => {
  for (const record of await allProductRecords(ctx)) {
    const metadata = asRecord(record.metadata)
    const resolve = async (values: unknown): Promise<string[]> => {
      const ids: string[] = []

      for (const value of asArray(values)) {
        const id = await destinationIdFor(ctx, {
          collection: 'products',
          resource: 'product',
          sourceRecordId: value as number | string,
        })
        if (id) ids.push(id)
      }

      return ids
    }
    const data: Loose = {}
    const grouped = await resolve(metadata.groupedIds)
    const upsells = await resolve(metadata.upsellIds)
    const crossSells = await resolve(metadata.crossSellIds)
    if (grouped.length) data.groupedProducts = grouped
    if (upsells.length) data.upsells = upsells
    if (crossSells.length) data.crossSells = crossSells
    if (!Object.keys(data).length) continue

    const updated = await updateDestinationDoc(ctx, {
      collection: 'products',
      data,
      id: String(record.destinationId),
    })
    await refreshRecordDestination(
      ctx,
      'product',
      str(record.sourceRecordId),
      isoOf(updated.updatedAt) || null,
    )
  }
}

/** Apply today's stock once, after history: the count Woo reports now, not a replay of sales. */
export const applyCurrentStock = async (ctx: Ctx): Promise<void> => {
  for (const record of await allProductRecords(ctx)) {
    const metadata = asRecord(record.metadata)
    const destinationId = str(record.destinationId)
    const product = await findDestinationDoc(ctx, 'products', destinationId)

    if (!product || idOf(product.site) !== ctx.siteId) continue

    const data: Loose = {}

    if (metadata.manageStock === true) {
      data.trackInventory = true
      data.inventory = Math.max(0, intOf(metadata.stockQuantity, 0))
    }

    const variationStock = new Map(
      (asArray(metadata.variationStock) as Loose[]).map((row) => [str(row.key), row]),
    )

    if (variationStock.size) {
      data.variations = (asArray(product.variations) as Loose[]).map((variation) => {
        const stock = variationStock.get(str(variation.key))

        if (!stock || stock.parentStock === true) return variation

        return {
          ...variation,
          inventory: Math.max(0, intOf(stock.stockQuantity, 0)),
          trackInventory: stock.manageStock === true,
        }
      })
    }

    if (!Object.keys(data).length) continue

    const updated = await updateDestinationDoc(ctx, {
      collection: 'products',
      data,
      id: destinationId,
    })
    await refreshRecordDestination(
      ctx,
      'product',
      str(record.sourceRecordId),
      isoOf(updated.updatedAt) || null,
    )
  }
}

// --- Customers / coupons ---------------------------------------------------------

export const importCustomers = async (ctx: Ctx): Promise<void> => {
  if (!ctx.inventory?.hasWooCommerce || !ctx.settings.includeCustomers || !commerceAllowed(ctx)) return
  const woo = wooClientOrBlock(ctx)

  await processPages(ctx, {
    client: woo,
    handler: async (raw) => {
      const sourceRecordId = sourceRecordIdOf(raw)!
      const billing = addressOf(raw.billing)
      const shipping = addressOf(raw.shipping)
      const addresses: Loose[] = []
      const hasAddress = (address: Loose): boolean =>
        Object.values(address).some((value) => typeof value === 'string' && value.trim())

      if (hasAddress(billing)) addresses.push({ ...billing, isDefaultBilling: true, label: 'صورت‌حساب' })
      if (hasAddress(shipping)) addresses.push({ ...shipping, isDefaultShipping: true, label: 'ارسال' })

      const email = str(raw.email).trim().toLowerCase()
      const adopt = email ? await findByFields(ctx, 'customers', { email }) : null
      const result = await upsertDestination(ctx, {
        ...(adopt ? { adoptId: String(adopt.id) } : {}),
        collection: 'customers',
        data: {
          addresses,
          claimStatus: 'unclaimed',
          displayName: str(raw.name) || `${str(raw.first_name)} ${str(raw.last_name)}`.trim(),
          email,
          firstName: str(raw.first_name),
          lastName: str(raw.last_name),
          phone: str(billing.phone),
          status: 'active',
          username: str(raw.username),
          ...provenance(ctx, {
            raw,
            sourceRecordId,
            sourceType: 'customer',
            system: 'woocommerce',
          }),
        },
        raw,
        resource: 'customers',
        sourceRecordId,
      })

      return actionDisposition(result.action)
    },
    params: { order: 'asc', orderby: 'id', ...modifiedParams(ctx) },
    path: '/wp-json/wc/v3/customers',
    resource: 'customers',
  })
}

export const importCoupons = async (ctx: Ctx): Promise<void> => {
  if (!ctx.inventory?.hasWooCommerce || !ctx.settings.includeCoupons || !commerceAllowed(ctx)) return
  const woo = wooClientOrBlock(ctx)

  await processPages(ctx, {
    client: woo,
    handler: async (raw) => {
      const sourceRecordId = sourceRecordIdOf(raw)!
      const discountType = str(raw.discount_type).replace('_', '-')
      const type = ['fixed-cart', 'fixed-product', 'percent'].includes(discountType)
        ? discountType
        : 'fixed-cart'
      const resolveProducts = async (values: unknown): Promise<string[]> => {
        const ids: string[] = []

        for (const value of asArray(values)) {
          const id = await destinationIdFor(ctx, {
            collection: 'products',
            resource: 'product',
            sourceRecordId: value as number | string,
          })
          if (id) ids.push(id)
        }

        return ids
      }
      const code = str(raw.code).trim().toUpperCase()
      const adopt = code ? await findByFields(ctx, 'coupons', { code }) : null
      const result = await upsertDestination(ctx, {
        ...(adopt ? { adoptId: String(adopt.id) } : {}),
        collection: 'coupons',
        data: {
          active: str(raw.status) !== 'draft',
          amount: type === 'percent' ? Number(raw.amount ?? 0) : money(ctx, raw.amount),
          code,
          description: plainText(raw.description),
          discountType: type,
          ...(str(raw.date_expires) ? { expiresAt: str(raw.date_expires) } : {}),
          excludedProducts: await resolveProducts(raw.excluded_product_ids),
          freeShipping: raw.free_shipping === true,
          individualUse: raw.individual_use === true,
          ...(Number(raw.maximum_amount ?? 0) > 0
            ? { maximumAmount: money(ctx, raw.maximum_amount) }
            : {}),
          ...(Number(raw.minimum_amount ?? 0) > 0
            ? { minimumAmount: money(ctx, raw.minimum_amount) }
            : {}),
          products: await resolveProducts(raw.product_ids),
          usageCount: intOf(raw.usage_count, 0),
          usageLimit: intOf(raw.usage_limit, 0) || null,
          usageLimitPerUser: intOf(raw.usage_limit_per_user, 0) || null,
          ...provenance(ctx, {
            raw,
            sourceRecordId,
            sourceType: 'coupon',
            system: 'woocommerce',
          }),
        },
        raw,
        resource: 'coupons',
        sourceRecordId,
      })

      return actionDisposition(result.action)
    },
    params: { order: 'asc', orderby: 'id', ...modifiedParams(ctx) },
    path: '/wp-json/wc/v3/coupons',
    resource: 'coupons',
  })
}

// --- Orders ----------------------------------------------------------------------

export type ConvertedOrder = {
  currency: string
  discountTotal: number
  fees: Loose[]
  feeTotal: number
  items: Loose[]
  shippingLines: Loose[]
  shippingTotal: number
  subtotal: number
  taxLines: Loose[]
  taxTotal: number
  total: number
}

/** Convert one Woo order's money once; importer, dry-run and reconciliation all read this. */
export const convertedOrder = (ctx: Ctx, raw: RawRecord): ConvertedOrder => {
  const check = reconcileWooOrderMoney(raw, ctx.settings.sourceDecimals)

  if (!check.ok) {
    throw new MigrationImportError('ORDER_TOTAL_MISMATCH', check.message, 'blocked')
  }

  const items = (asArray(raw.line_items) as Loose[]).map((line) => {
    const quantity = intOf(line.quantity, 0)
    const subtotal = money(ctx, line.subtotal)
    let unitPrice: number

    if (line.price !== undefined && line.price !== null && line.price !== '') {
      unitPrice = money(ctx, line.price)
    } else if (quantity > 0 && subtotal % quantity === 0) {
      unitPrice = subtotal / quantity
    } else {
      throw new MigrationImportError(
        'ORDER_LINE_PRICE',
        'قیمت واحد سطر سفارش از جمع سطر به‌طور دقیق به دست نمی‌آید.',
        'blocked',
      )
    }

    const taxes = asArray(line.taxes) as Loose[]

    return {
      productSourceId: line.product_id,
      productTitle: plainText(line.name),
      quantity,
      sku: str(line.sku),
      sourceLineId: line.id ? String(line.id) : null,
      subtotal,
      taxTotal: taxes.reduce((sum, tax) => sum + money(ctx, tax.total), 0),
      total: money(ctx, line.total),
      unitPrice,
      variationLabel:
        (asArray(line.meta_data) as Loose[])
          .map((meta) => str(meta.value))
          .filter(Boolean)
          .join(' / ') || null,
      variationSourceId: intOf(line.variation_id, 0),
    }
  })
  const fees = (asArray(raw.fee_lines) as Loose[]).map((fee) => ({
    name: plainText(fee.name) || 'هزینه',
    taxTotal: money(ctx, fee.total_tax),
    total: money(ctx, fee.total),
  }))

  return {
    currency: ctx.settings.targetCurrency,
    discountTotal: money(ctx, raw.discount_total),
    fees,
    feeTotal: fees.reduce((sum, fee) => sum + Number(fee.total), 0),
    items,
    shippingLines: (asArray(raw.shipping_lines) as Loose[]).map((line) => ({
      methodId: str(line.method_id),
      methodTitle: plainText(line.method_title) || 'ارسال',
      taxTotal: money(ctx, line.total_tax),
      total: money(ctx, line.total),
    })),
    shippingTotal: money(ctx, raw.shipping_total),
    subtotal: items.reduce((sum, item) => sum + Number(item.subtotal), 0),
    taxLines: (asArray(raw.tax_lines) as Loose[]).map((line) => ({
      label: plainText(line.label) || 'مالیات',
      rateCode: str(line.rate_code),
      ratePercent: Number(line.rate_percent ?? 0),
      shippingTaxTotal: money(ctx, line.shipping_tax_total),
      taxTotal: money(ctx, line.tax_total),
    })),
    taxTotal: money(ctx, raw.total_tax),
    total: money(ctx, raw.total),
  }
}

export const importOrders = async (ctx: Ctx): Promise<void> => {
  if (!ctx.inventory?.hasWooCommerce || !ctx.settings.includeOrders || !commerceAllowed(ctx)) return
  const woo = wooClientOrBlock(ctx)

  await processPages(ctx, {
    client: woo,
    handler: async (raw) => {
      throwIfCoverageBlocked(ctx, 'orders')
      const sourceRecordId = sourceRecordIdOf(raw)!
      const converted = convertedOrder(ctx, raw)

      if (converted.items.length === 0) {
        throw new MigrationImportError(
          'EMPTY_ORDER',
          'سفارش سطر ندارد و به‌صورت سفارش تک‌محصولی ساختگی وارد نمی‌شود.',
          'blocked',
        )
      }

      const items: Loose[] = []

      for (const item of converted.items) {
        const productId = await destinationIdFor(ctx, {
          collection: 'products',
          resource: 'product',
          sourceRecordId: item.productSourceId as number | string,
        })

        if (!productId) {
          throw new MigrationImportError(
            'ORDER_PRODUCT_MISSING',
            `محصول مبدأ ${String(item.productSourceId)} در مقصد نیست؛ سفارش بدون سطرش وارد نمی‌شود.`,
            'blocked',
          )
        }

        items.push({
          product: productId,
          productTitle: item.productTitle,
          quantity: item.quantity,
          ...(item.sku ? { sku: item.sku } : {}),
          ...(item.sourceLineId ? { sourceLineId: item.sourceLineId } : {}),
          subtotal: item.subtotal,
          taxTotal: item.taxTotal,
          total: item.total,
          unitPrice: item.unitPrice,
          ...(Number(item.variationSourceId) > 0
            ? {
                variationKey: `source-${String(item.variationSourceId)}`,
                ...(item.variationLabel ? { variationLabel: item.variationLabel } : {}),
              }
            : {}),
        })
      }

      const customerSourceId = intOf(raw.customer_id, 0)
      let customerId: null | string = null

      if (customerSourceId > 0) {
        customerId = await destinationIdFor(ctx, {
          collection: 'customers',
          resource: 'customers',
          sourceRecordId: customerSourceId,
        })
        if (!customerId) {
          throw new MigrationImportError(
            'ORDER_CUSTOMER_MISSING',
            `مشتری مبدأ ${customerSourceId} در مقصد نیست؛ رابطه سفارش-مشتری حذف نمی‌شود.`,
            'blocked',
          )
        }
      }

      const billing = addressOf(raw.billing)
      const shipping = addressOf(raw.shipping)
      const buyerName =
        `${str(billing.firstName)} ${str(billing.lastName)}`.trim() || str(billing.email)
      const buyerPhone = str(billing.phone).trim()

      if (!buyerName || !buyerPhone) {
        throw new MigrationImportError(
          'ORDER_BUYER_MISSING',
          'سفارش نام یا تلفن خریدار ندارد و بدون ساختن خریدار ساختگی مسدود ماند.',
          'blocked',
        )
      }

      const coupons: Loose[] = []

      for (const couponLine of asArray(raw.coupon_lines)) {
        const line = asRecord(couponLine)
        const code = str(line.code).trim().toUpperCase()
        let couponId: null | string = null

        if (line.id) {
          couponId = await destinationIdFor(ctx, {
            collection: 'coupons',
            resource: 'coupons',
            sourceRecordId: line.id as number | string,
          })
        }
        if (!couponId && code) {
          const found = await findByFields(ctx, 'coupons', { code })
          couponId = found ? String(found.id) : null
        }

        coupons.push({
          code,
          ...(couponId ? { coupon: couponId } : {}),
          discount: money(ctx, line.discount),
        })
      }

      let refundRows = asArray(raw.refunds) as Loose[]

      if (refundRows.length > 0) {
        refundRows = (await woo
          .collect(`/wp-json/wc/v3/orders/${sourceRecordId}/refunds`)
          .catch(() => refundRows)) as unknown as Loose[]
      }

      const refunds = refundRows.map((refund) => ({
        amount: Math.abs(money(ctx, refund.amount ?? refund.total)),
        reason: plainText(refund.reason),
        ...(str(refund.date_created_gmt || refund.date_created)
          ? { refundedAt: `${str(refund.date_created_gmt || refund.date_created).replace(/(Z|[+-]\d{2}:?\d{2})$/, '')}Z` }
          : {}),
        ...(refund.id ? { sourceId: String(refund.id) } : {}),
        ...(str(refund.transaction_id) ? { transactionId: str(refund.transaction_id) } : {}),
      }))
      const status = mapWooOrderStatus(str(raw.status))
      const method = str(raw.payment_method)
      const provider = method in paymentProviders ? method : 'bank'
      const paidAt = str(raw.date_paid_gmt || raw.date_paid)
      const hashRaw = { ...raw, __eshobe_refunds: refundRows }
      const result = await upsertDestination(ctx, {
        collection: 'orders',
        data: {
          billingAddress: billing,
          buyer: {
            ...(str(billing.email) ? { email: str(billing.email) } : {}),
            name: buyerName,
            phone: buyerPhone,
          },
          coupons,
          currency: converted.currency,
          ...(customerId ? { customer: customerId } : {}),
          ...(plainText(raw.customer_note) ? { customerNote: plainText(raw.customer_note) } : {}),
          discountTotal: converted.discountTotal,
          fees: converted.fees,
          items,
          payment: {
            ...(paidAt ? { paidAt: `${paidAt.replace(/(Z|[+-]\d{2}:?\d{2})$/, '')}Z` } : {}),
            provider,
            ...(str(raw.transaction_id) ? { reference: str(raw.transaction_id) } : {}),
          },
          paymentHistory:
            method || str(raw.transaction_id)
              ? [
                  {
                    amount: converted.total,
                    ...(method ? { methodId: method } : {}),
                    ...(str(raw.payment_method_title)
                      ? { methodTitle: str(raw.payment_method_title) }
                      : {}),
                    ...(paidAt ? { paidAt: `${paidAt.replace(/(Z|[+-]\d{2}:?\d{2})$/, '')}Z` } : {}),
                    status: str(raw.status),
                    ...(str(raw.transaction_id)
                      ? { transactionId: str(raw.transaction_id) }
                      : {}),
                  },
                ]
              : [],
          product: items[0]!.product,
          quantity: items[0]!.quantity,
          reference: `WOO-${str(raw.number) || sourceRecordId}`,
          refunds,
          shippingAddress: shipping,
          shippingLines: converted.shippingLines,
          shippingTotal: converted.shippingTotal,
          status: status.target,
          subtotal: converted.subtotal,
          taxLines: converted.taxLines,
          taxTotal: converted.taxTotal,
          total: converted.total,
          unitPrice: items[0]!.unitPrice,
          ...provenance(ctx, {
            raw: hashRaw,
            sourceRecordId,
            sourceType: 'order',
            system: 'woocommerce',
          }),
        },
        metadata: {
          lineCount: items.length,
          refundTotal: refunds.reduce((sum, refund) => sum + Number(refund.amount), 0),
          sourceStatusLossy: status.lossy,
          totals: {
            discountTotal: converted.discountTotal,
            shippingTotal: converted.shippingTotal,
            subtotal: converted.subtotal,
            taxTotal: converted.taxTotal,
            total: converted.total,
          },
        },
        raw: hashRaw,
        resource: 'orders',
        sourceRecordId,
      })

      return actionDisposition(result.action)
    },
    params: { order: 'asc', orderby: 'id', status: 'any', ...modifiedParams(ctx) },
    path: '/wp-json/wc/v3/orders',
    resource: 'orders',
  })
}

// --- Explicit ACF relationships ----------------------------------------------

export const CONTENT_RELATION_TARGET_FIELDS: Record<string, string> = {
  'content-entries': 'targetEntry',
  media: 'targetMedia',
  pages: 'targetPage',
  posts: 'targetPost',
  products: 'targetProduct',
}

const allMigrationDocs = async (ctx: Ctx, collection: string, where: Loose): Promise<Loose[]> => {
  const { docs } = await ctx.req.payload.find({
    collection: collection as never,
    depth: 0,
    draft: true,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    req: ctx.req,
    where: where as never,
  })

  return docs as unknown as Loose[]
}

const retireContentRelation = async (ctx: Ctx, relation: Loose): Promise<void> => {
  const relationId = String(relation.id ?? '')
  if (!relationId) return

  const sourceRecordId = str(asRecord(relation.source).sourceId)

  await ctx.req.payload.delete({
    id: relationId,
    collection: 'content-relations',
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })

  if (sourceRecordId) {
    ctx.destinationCache.delete(`content-relation:${sourceRecordId}`)
    await upsertMigrationRecord(ctx.req, {
      destinationCollection: null,
      destinationId: null,
      destinationUpdatedAt: null,
      disposition: 'deleted',
      installation: ctx.installation,
      jobId: ctx.jobId,
      resource: 'content-relation',
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
      sourceRecordId,
    })
  }
}

/**
 * Finish explicitly mapped ACF relationships after every possible target
 * exists. `fieldValues` receives destination ids and `content-relations`
 * receives the navigable edge; taxonomy targets stay field values because
 * the edge model has entry-term relations for taxonomies instead. A field
 * with an unresolved target remains in `unmappedMeta` with an open error —
 * never a partial field value presented as complete.
 */
export const syncAcfRelationships = async (ctx: Ctx): Promise<void> => {
  const pending = ctx.pendingContentRelations.splice(0)
  if (!pending.length) return

  const byEntry = new Map<string, typeof pending>()

  for (const spec of pending) {
    const list = byEntry.get(spec.entryId) ?? []
    list.push(spec)
    byEntry.set(spec.entryId, list)
  }

  for (const [entryId, specs] of byEntry) {
    await checkControl(ctx)
    const entry = await findDestinationDoc(ctx, 'content-entries', entryId)
    if (!entry) continue

    const sourceType = specs[0]?.sourceType ?? ''
    const sourceEntryRecordId = specs[0]?.sourceEntryRecordId ?? ''
    const nextValues: Loose = { ...asRecord(entry.fieldValues) }
    const nextUnmapped: Loose = { ...asRecord(entry.unmappedMeta) }

    for (const spec of specs) {
      const errorRecordId = `${spec.sourceEntryRecordId}:${spec.fieldKey}`

      try {
        const sourceIds = sourceIdsFromRelationValue(spec.value)

        if (spec.relationTo === 'media' && !ctx.settings.includeMedia) {
          if (sourceIds.length) {
            delete nextValues[spec.fieldKey]
            nextUnmapped[spec.fieldKey] = redactRawPayload(spec.value)
          }
          continue
        }

        if (!sourceIds.length) {
          delete nextValues[spec.fieldKey]
          delete nextUnmapped[spec.fieldKey]

          if (CONTENT_RELATION_TARGET_FIELDS[spec.relationTo]) {
            const existing = await allMigrationDocs(ctx, 'content-relations', {
              and: [
                { site: { equals: ctx.siteId } },
                { fromEntry: { equals: entryId } },
                { relationKind: { equals: `acf:${spec.fieldKey}` } },
                { 'source.installation': { equals: ctx.installation } },
              ],
            })
            for (const relation of existing) await retireContentRelation(ctx, relation)
          }
          continue
        }

        const resolved = await resolveRelationValue(ctx, spec.relationTo, spec.value)

        if (resolved.unresolved.length) {
          delete nextValues[spec.fieldKey]
          nextUnmapped[spec.fieldKey] = redactRawPayload(spec.value)
          ctx.counts.errors += 1
          await recordMigrationError(ctx.req, {
            code: 'ACF_RELATION_TARGET_MISSING',
            error: new Error(
              `مقصد رابطه صریح «${spec.fieldKey}» برای شناسه‌های ${resolved.unresolved.join('، ')} پیدا نشد؛ مقدار در unmappedMeta ماند.`,
            ),
            jobId: ctx.jobId,
            resource: 'content-relation',
            siteId: ctx.siteId,
            sourceId: ctx.sourceId,
            sourceRecordId: errorRecordId,
          })
          continue
        }

        const targetField = CONTENT_RELATION_TARGET_FIELDS[spec.relationTo]

        if (targetField) {
          const desired = new Map(
            resolved.pairs.map((pair) => [
              `${spec.sourceEntryRecordId}:${spec.fieldKey}:${pair.sourceId}`,
              pair,
            ]),
          )
          const existing = await allMigrationDocs(ctx, 'content-relations', {
            and: [
              { site: { equals: ctx.siteId } },
              { fromEntry: { equals: entryId } },
              { relationKind: { equals: `acf:${spec.fieldKey}` } },
              { 'source.installation': { equals: ctx.installation } },
            ],
          })

          for (const relation of existing) {
            const syntheticId = str(asRecord(relation.source).sourceId)
            if (!desired.has(syntheticId)) await retireContentRelation(ctx, relation)
          }

          for (const [index, pair] of resolved.pairs.entries()) {
            const syntheticId = `${spec.sourceEntryRecordId}:${spec.fieldKey}:${pair.sourceId}`
            const raw = acfContentRelationRaw(
              spec.sourceEntryRecordId,
              spec.fieldKey,
              spec.relationTo,
              pair.sourceId,
            )

            await upsertDestination(ctx, {
              collection: 'content-relations',
              data: {
                fromEntry: entryId,
                relationKind: `acf:${spec.fieldKey}`,
                menuOrder: index,
                targetCollection: spec.relationTo,
                targetEntry: null,
                targetMedia: null,
                targetPage: null,
                targetPost: null,
                targetProduct: null,
                [targetField]: pair.destinationId,
                ...provenance(ctx, {
                  raw,
                  sourceRecordId: syntheticId,
                  sourceType: 'acf_relationship',
                  system: 'wordpress',
                }),
              },
              raw,
              resource: 'content-relation',
              sourceRecordId: syntheticId,
            })
          }
        }

        const ids = resolved.pairs.map((pair) => pair.destinationId)
        nextValues[spec.fieldKey] = Array.isArray(spec.value) ? ids : ids[0]
        delete nextUnmapped[spec.fieldKey]
        await resolveMigrationErrors(ctx.req, {
          code: 'ACF_RELATION_TARGET_MISSING',
          jobId: ctx.jobId,
          resource: 'content-relation',
          siteId: ctx.siteId,
          sourceId: ctx.sourceId,
          sourceRecordId: errorRecordId,
        })
      } catch (error) {
        ctx.counts.errors += 1
        delete nextValues[spec.fieldKey]
        nextUnmapped[spec.fieldKey] = redactRawPayload(spec.value)
        await recordMigrationError(ctx.req, {
          code: error instanceof MigrationImportError ? error.code : 'ACF_RELATION_SYNC_ERROR',
          error,
          jobId: ctx.jobId,
          resource: 'content-relation',
          siteId: ctx.siteId,
          sourceId: ctx.sourceId,
          sourceRecordId: errorRecordId,
        }).catch(() => undefined)
      }
    }

    const changed =
      JSON.stringify(nextValues) !== JSON.stringify(asRecord(entry.fieldValues)) ||
      JSON.stringify(nextUnmapped) !== JSON.stringify(asRecord(entry.unmappedMeta))

    if (changed && sourceEntryRecordId) {
      const updated = await updateDestinationDoc(ctx, {
        collection: 'content-entries',
        data: { fieldValues: nextValues, unmappedMeta: nextUnmapped },
        id: entryId,
      })
      await refreshRecordDestination(
        ctx,
        `post-type:${sourceType}`,
        sourceEntryRecordId,
        isoOf(updated.updatedAt) || null,
      )
    }
  }
}

// --- Menus --------------------------------------------------------------------

export const WORDPRESS_MENUS_PATH = '/wp-json/wp/v2/menus'
export const WORDPRESS_MENU_ITEMS_PATH = '/wp-json/wp/v2/menu-items'

const sortMenuItems = (items: RawRecord[]): RawRecord[] =>
  [...items].sort((a, b) => {
    const order = intOf(a.menu_order, 0) - intOf(b.menu_order, 0)
    return order || String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })

export const menuIdsOfItem = (item: RawRecord): string[] => {
  const raw = item.menus ?? item.menu ?? item.menu_id
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]

  return values
    .map((value) =>
      typeof value === 'object' && value !== null ? str(asRecord(value).id ?? asRecord(value).ID) : str(value),
    )
    .filter(Boolean)
}

export type WordPressMenuAggregate = {
  itemsByMenu: Map<string, RawRecord[]>
  menus: RawRecord[]
  orphanItems: RawRecord[]
}

export const menuItemOrphanRecordId = (item: RawRecord, index = 0): string =>
  `menu-item:${sourceRecordIdOf(item) ?? `missing-id-${index}`}`

export const collectWordPressMenus = async (ctx: Ctx): Promise<WordPressMenuAggregate> => {
  const [menus, items] = await Promise.all([
    ctx.clients.wp.collect<RawRecord>(WORDPRESS_MENUS_PATH, { context: 'edit' }),
    ctx.clients.wp.collect<RawRecord>(WORDPRESS_MENU_ITEMS_PATH, {
      context: 'edit',
      order: 'asc',
      orderby: 'id',
      status: 'any',
    }),
  ])
  const itemsByMenu = new Map<string, RawRecord[]>()
  const knownMenuIds = new Set(menus.map((menu) => sourceRecordIdOf(menu)).filter(Boolean))
  const orphanItems: RawRecord[] = []

  for (const item of items) {
    const claimedMenuIds = menuIdsOfItem(item)
    const knownMenuIdsForItem = claimedMenuIds.filter((menuId) => knownMenuIds.has(menuId))

    // An item with no menu reference, or one pointing at a menu the menus
    // endpoint did not return, must not disappear merely because the known
    // menus imported cleanly. Keep it separate for explicit blocked ledger
    // accounting by import, dry-run and reconciliation.
    if (!knownMenuIdsForItem.length) {
      orphanItems.push(item)
      continue
    }

    for (const menuId of knownMenuIdsForItem) {
      const list = itemsByMenu.get(menuId) ?? []
      list.push(item)
      itemsByMenu.set(menuId, list)
    }
  }

  for (const [menuId, list] of itemsByMenu) itemsByMenu.set(menuId, sortMenuItems(list))

  return { itemsByMenu, menus, orphanItems: sortMenuItems(orphanItems) }
}

export const menuAggregateRaw = (menu: RawRecord, items: RawRecord[]): RawRecord => ({
  ...menu,
  __eshobe_menu_items: sortMenuItems(items),
})

export type WordPressMenuOrphanRecord = {
  claimedMenuIds: string[]
  items: RawRecord[]
  raw: RawRecord
  sourceRecordId: string
}

/**
 * Ledger shape for menu items whose menu cannot be imported. Items pointing
 * at a menu ID the menus endpoint omitted are grouped under that claimed ID:
 * if a later scan returns the menu, its normal import upserts the same
 * ledger key and supersedes the blocked row. Items with no menu reference at
 * all get a per-item synthetic key.
 */
export const menuOrphanRecords = (orphanItems: RawRecord[]): WordPressMenuOrphanRecord[] => {
  const groups = new Map<string, { claimedMenuIds: string[]; items: RawRecord[] }>()

  orphanItems.forEach((item, index) => {
    const claimedMenuIds = menuIdsOfItem(item)
    const sourceRecordId = claimedMenuIds[0] ?? menuItemOrphanRecordId(item, index)
    const group = groups.get(sourceRecordId) ?? { claimedMenuIds, items: [] }
    group.items.push(item)
    groups.set(sourceRecordId, group)
  })

  return [...groups.entries()].map(([sourceRecordId, group]) => ({
    claimedMenuIds: group.claimedMenuIds,
    items: group.items,
    raw: group.claimedMenuIds.length
      ? menuAggregateRaw({ id: sourceRecordId }, group.items)
      : group.items[0]!,
    sourceRecordId,
  }))
}

const menuLocationsOf = (menu: RawRecord): string[] => {
  const values: unknown[] = []

  for (const candidate of [menu.locations, menu.location, menu.theme_location]) {
    if (Array.isArray(candidate)) values.push(...candidate)
    else if (candidate && typeof candidate === 'object') values.push(...Object.keys(asRecord(candidate)))
    else if (candidate !== undefined && candidate !== null) values.push(candidate)
  }

  return [...new Set(values.map((value) => str(value).trim()).filter(Boolean))]
}

const sameMenuHost = (hostname: string, other: string): boolean =>
  hostname.replace(/^www\./, '').toLowerCase() === other.replace(/^www\./, '').toLowerCase()

const rewrittenMenuUrl = (ctx: Ctx, value: unknown): string => {
  const raw = str(value).trim()

  if (/^\/[^/\\]/.test(raw) || raw === '/') return raw

  let parsed: URL

  try {
    parsed = new URL(raw)
  } catch {
    throw new MigrationImportError(
      'MENU_ITEM_URL_INVALID',
      'نشانی یکی از آیتم‌های منو معتبر نیست؛ منو بدون حذف آن آیتم مسدود ماند.',
      'blocked',
    )
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MigrationImportError(
      'MENU_ITEM_URL_UNSAFE',
      'نشانی یکی از آیتم‌های منو غیر http(s) است؛ منو مسدود ماند.',
      'blocked',
    )
  }

  const sourceHost = new URL(String(ctx.source.baseUrl)).hostname

  return sameMenuHost(parsed.hostname, sourceHost)
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString()
}

type MenuTarget = { collection: string; resource: string }

const menuTargetFor = (item: RawRecord): MenuTarget | null => {
  const type = str(item.type).toLowerCase()
  const object = str(item.object).toLowerCase()

  if (type === 'custom' || type === 'post_type_archive' || object === 'custom') return null

  if (type === 'taxonomy') {
    if (!object) {
      throw new MigrationImportError(
        'MENU_ITEM_OBJECT_MISSING',
        'گونه طبقه‌بندی یکی از آیتم‌های منو مشخص نیست؛ منو مسدود ماند.',
        'blocked',
      )
    }
    return object === 'category'
      ? { collection: 'categories', resource: 'taxonomy:category' }
      : { collection: 'taxonomy-terms', resource: `taxonomy:${object}` }
  }

  if (type === 'post_type' || (!type && object)) {
    if (!object) {
      throw new MigrationImportError(
        'MENU_ITEM_OBJECT_MISSING',
        'گونه محتوای یکی از آیتم‌های منو مشخص نیست؛ منو مسدود ماند.',
        'blocked',
      )
    }
    if (object === 'post') return { collection: 'posts', resource: 'post-type:post' }
    if (object === 'page') return { collection: 'pages', resource: 'post-type:page' }
    if (object === 'product') return { collection: 'products', resource: 'product' }
    if (object === 'attachment') return { collection: 'media', resource: 'media' }
    return { collection: 'content-entries', resource: `post-type:${object}` }
  }

  if (!type && !object) return null

  throw new MigrationImportError(
    'MENU_ITEM_TYPE_UNSUPPORTED',
    `گونه آیتم منو «${type || object}» نگاشت بومی ندارد؛ منو مسدود ماند.`,
    'blocked',
  )
}

const menuItemData = async (ctx: Ctx, item: RawRecord): Promise<Loose> => {
  const itemId = sourceRecordIdOf(item)
  const status = mapWordPressStatus(str(item.status) || 'publish')

  if (!itemId) {
    throw new MigrationImportError(
      'MENU_ITEM_ID_MISSING',
      'یکی از آیتم‌های منو شناسه مبدأ ندارد و بدون حذفش منو مسدود ماند.',
      'blocked',
    )
  }
  if (!status.target) {
    throw new MigrationImportError(
      'MENU_ITEM_STATUS_UNSUPPORTED',
      `وضعیت آیتم منو «${status.original}» نگاشت بومی ندارد؛ منو مسدود ماند.`,
      'blocked',
    )
  }

  const classes = Array.isArray(item.classes)
    ? item.classes.map((value) => str(value)).filter(Boolean).join(' ')
    : plainText(item.classes)
  const target = menuTargetFor(item)
  const label =
    plainText(item.title) || plainText(item.attr_title) || plainText(item.url) || `آیتم ${itemId}`
  const data: Loose = {
    ...(classes ? { cssClasses: classes } : {}),
    ...(plainText(item.description) ? { description: plainText(item.description) } : {}),
    key: itemId,
    label,
    menuOrder: intOf(item.menu_order, 0),
    newTab: str(item.target).toLowerCase() === '_blank',
    ...(intOf(item.parent, 0) > 0 ? { parentKey: String(item.parent) } : {}),
    sourceObjectId: item.object_id ? String(item.object_id) : undefined,
    sourceObjectType: str(item.object) || str(item.type) || undefined,
    sourceUrl: str(item.url) || undefined,
    status: status.target,
  }

  if (!target) {
    if (!str(item.url)) {
      throw new MigrationImportError(
        'MENU_ITEM_URL_MISSING',
        'آیتم دل‌خواه منو نشانی ندارد؛ منو مسدود ماند.',
        'blocked',
      )
    }
    Object.assign(data, { type: 'custom', url: rewrittenMenuUrl(ctx, item.url) })
    return data
  }

  const objectId = item.object_id as number | string | undefined

  if (objectId === undefined || objectId === null || String(objectId).trim() === '') {
    throw new MigrationImportError(
      'MENU_ITEM_TARGET_MISSING',
      'شناسه مقصد یکی از آیتم‌های منو در مبدأ نیست؛ منو بدون حذف آیتم مسدود ماند.',
      'blocked',
    )
  }

  const destinationId = await destinationIdFor(ctx, {
    collection: target.collection,
    resource: target.resource,
    sourceRecordId: objectId,
  })

  if (!destinationId) {
    throw new MigrationImportError(
      'MENU_ITEM_TARGET_MISSING',
      `مقصد آیتم منو «${String(objectId)}» در ${target.collection} پیدا نشد؛ منو مسدود ماند.`,
      'blocked',
    )
  }

  Object.assign(data, {
    reference: { relationTo: target.collection, value: destinationId },
    type: 'reference',
  })

  return data
}

const menusEndpointUnavailable = (error: unknown): boolean =>
  error instanceof WordPressApiError &&
  (error.status === 404 || /no_route|not_found/i.test(error.code ?? ''))

export const importMenus = async (ctx: Ctx): Promise<void> => {
  if (!ctx.settings.includeMenus) return

  let aggregate: WordPressMenuAggregate

  try {
    aggregate = await collectWordPressMenus(ctx)
  } catch (error) {
    if (!menusEndpointUnavailable(error)) throw error

    ctx.counts.seen += 1
    ctx.counts.blocked += 1
    const raw: RawRecord = { endpoint: WORDPRESS_MENUS_PATH, id: 'menus' }
    await recordDisposition(ctx, {
      disposition: 'blocked',
      raw,
      resource: 'menus',
      sourceRecordId: 'menus',
    }).catch(() => undefined)
    await recordMigrationError(ctx.req, {
      code: 'MENUS_ENDPOINT_UNAVAILABLE',
      error: new Error(
        'این مبدأ وردپرس مسیر REST منوها را ارائه نمی‌کند؛ منوها مسدود ماندند و از کشف حذف نمی‌شوند.',
      ),
      jobId: ctx.jobId,
      resource: 'menus',
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
      sourceRecordId: 'menus',
    }).catch(() => undefined)
    return
  }

  const menus = [...aggregate.menus].sort((a, b) =>
    String(a.id ?? '').localeCompare(String(b.id ?? '')),
  )

  for (const menu of menus) {
    await checkControl(ctx)
    const sourceRecordId = sourceRecordIdOf(menu)
    ctx.counts.seen += 1
    const items = sourceRecordId ? (aggregate.itemsByMenu.get(sourceRecordId) ?? []) : []
    const raw = menuAggregateRaw(menu, items)

    try {
      if (!sourceRecordId) {
        throw new MigrationImportError(
          'MENU_ID_MISSING',
          'منوی مبدأ شناسه ندارد و به‌صورت مسدود ثبت شد.',
          'blocked',
        )
      }
      if (items.length > 1_000) {
        throw new MigrationImportError(
          'MENU_TOO_LARGE',
          'منو بیش از سقف ۱۰۰۰ آیتم دارد و برای تقسیم دستی مسدود ماند.',
          'blocked',
        )
      }

      const slug = preserveWordPressSlug(menu.slug ?? `menu-${sourceRecordId}`)
      const itemRows: Loose[] = []

      for (const item of items) itemRows.push(await menuItemData(ctx, item))

      const locations = menuLocationsOf(menu)
      const result = await upsertDestination(ctx, {
        collection: 'menus',
        data: {
          ...(plainText(menu.description) ? { description: plainText(menu.description) } : {}),
          isActive: true,
          items: itemRows,
          ...(locations[0] ? { location: locations[0] } : {}),
          locations,
          name: plainText(menu.name) || slug,
          slug,
          ...provenance(ctx, {
            raw,
            sourceRecordId,
            sourceType: 'menu',
            system: 'wordpress',
          }),
        },
        metadata: { itemCount: itemRows.length, locations },
        raw,
        resource: 'menus',
        sourceRecordId,
      })

      if (result.action === 'created') ctx.counts.imported += 1
      else if (result.action === 'updated') ctx.counts.updated += 1
      else ctx.counts.unchanged += 1
    } catch (error) {
      const disposition = error instanceof MigrationImportError ? error.disposition : 'error'
      if (disposition === 'blocked') ctx.counts.blocked += 1
      else ctx.counts.errors += 1
      const recordId = sourceRecordId ?? 'menu-missing-id'
      await recordDisposition(ctx, {
        disposition,
        raw,
        resource: 'menus',
        sourceRecordId: recordId,
      }).catch(() => undefined)
      await recordMigrationError(ctx.req, {
        code: error instanceof MigrationImportError ? error.code : 'MENU_IMPORT_ERROR',
        error,
        jobId: ctx.jobId,
        resource: 'menus',
        retryable: disposition !== 'blocked',
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId: recordId,
      }).catch(() => undefined)
    }
  }

  for (const orphan of menuOrphanRecords(aggregate.orphanItems)) {
    await checkControl(ctx)
    ctx.counts.seen += 1
    ctx.counts.blocked += 1
    await recordDisposition(ctx, {
      disposition: 'blocked',
      metadata: {
        claimedMenuIds: orphan.claimedMenuIds,
        menuItemIds: orphan.items.map((item) => sourceRecordIdOf(item)),
        orphanReason: orphan.claimedMenuIds.length ? 'unknown-menu' : 'missing-menu',
      },
      raw: orphan.raw,
      resource: 'menus',
      sourceRecordId: orphan.sourceRecordId,
    }).catch(() => undefined)
    await recordMigrationError(ctx.req, {
      code: 'MENU_ITEM_MENU_MISSING',
      error: new Error(
        orphan.claimedMenuIds.length
          ? `آیتم منو به منویی اشاره می‌کند که endpoint منوها برنگرداند (${orphan.claimedMenuIds.join('، ')}).`
          : 'آیتم منو هیچ منوی مبدأ قابل کشف ندارد.',
      ),
      jobId: ctx.jobId,
      resource: 'menus',
      retryable: false,
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
      sourceRecordId: orphan.sourceRecordId,
    }).catch(() => undefined)
  }
}

// --- Comments -----------------------------------------------------------------

export const WORDPRESS_COMMENTS_PATH = '/wp-json/wp/v2/comments'
export const WORDPRESS_COMMENT_TYPES = ['comment', 'review'] as const
export const WOO_PRODUCT_REVIEWS_PATH = '/wp-json/wc/v3/products/reviews'
const WOO_REVIEW_STATUSES = ['approved', 'hold', 'spam', 'trash'] as const
// WordPress's `status=all` means only approved + held comments; spam and
// trashed comments are excluded. `any` is the WP_Comment_Query value that
// really returns every moderation state, which is what preserving comment
// history (rather than silently dropping its spam/trash) requires.
export const WORDPRESS_COMMENTS_STATUS = 'any'

export const commentStatusOf = (raw: RawRecord): 'approved' | 'pending' | 'spam' | 'trash' => {
  const status = str(raw.status || 'approved').toLowerCase()

  switch (status) {
    case '1':
    case 'approve':
    case 'approved':
      return 'approved'
    case '0':
    case 'hold':
    case 'pending':
    case 'unapproved':
      return 'pending'
    case 'spam':
      return 'spam'
    case 'post-trashed':
    case 'trash':
    case 'trashed':
      return 'trash'
    default:
      throw new MigrationImportError(
        'COMMENT_STATUS_UNSUPPORTED',
        `وضعیت دیدگاه «${status}» نگاشت بومی ندارد و دیدگاه مسدود ماند.`,
        'blocked',
      )
  }
}

export const commentRatingOf = (raw: RawRecord): null | number => {
  const meta = asRecord(raw.meta)
  const value = num(raw.rating ?? meta.rating ?? meta._rating)

  if (value === null) return null
  if (value < 0 || value > 5) {
    throw new MigrationImportError(
      'COMMENT_RATING_INVALID',
      'امتیاز بازخورد بیرون بازه ۰ تا ۵ است؛ دیدگاه بدون گرد کردن امتیاز مسدود ماند.',
      'blocked',
    )
  }

  return value
}

const commentTargetData = async (
  ctx: Ctx,
  raw: RawRecord,
): Promise<{ collection: string; field: string; id: string }> => {
  const targetSourceId = raw.post ?? raw.post_id ?? raw.product_id

  if (
    targetSourceId === undefined ||
    targetSourceId === null ||
    String(targetSourceId).trim() === '' ||
    Number(targetSourceId) === 0
  ) {
    throw new MigrationImportError(
      'COMMENT_TARGET_MISSING',
      'دیدگاه سند مقصد در مبدأ ندارد و بدون مقصد مسدود ماند.',
      'blocked',
    )
  }

  const candidates: { collection: string; field: string; resource: string; type?: string }[] = [
    { collection: 'posts', field: 'targetPost', resource: 'post-type:post', type: 'post' },
    { collection: 'pages', field: 'targetPage', resource: 'post-type:page', type: 'page' },
    { collection: 'products', field: 'targetProduct', resource: 'product', type: 'product' },
    {
      collection: 'content-entries',
      field: 'targetEntry',
      resource: 'comment-target:content-entries',
    },
  ]
  const sourcePostType = str(raw.post_type).toLowerCase()
  const ordered = sourcePostType
    ? [
        ...candidates.filter(
          (candidate) =>
            candidate.type === sourcePostType ||
            (!candidate.type && !['page', 'post', 'product'].includes(sourcePostType)),
        ),
        ...candidates.filter(
          (candidate) =>
            candidate.type !== sourcePostType &&
            (candidate.type || ['page', 'post', 'product'].includes(sourcePostType)),
        ),
      ]
    : candidates

  for (const candidate of ordered) {
    const id = await destinationIdFor(ctx, {
      collection: candidate.collection,
      resource: candidate.resource,
      sourceRecordId: targetSourceId as number | string,
    })
    if (id) return { collection: candidate.collection, field: candidate.field, id }
  }

  throw new MigrationImportError(
    'COMMENT_TARGET_MISSING',
    `سند مقصد دیدگاه «${String(targetSourceId)}» در مقصد نیست؛ دیدگاه مسدود ماند.`,
    'blocked',
  )
}

/**
 * WooCommerce stores a product review's rating in comment meta, but core's
 * comments endpoint only returns meta a plugin explicitly registers for REST;
 * WooCommerce does not register `rating`, so the WP rows above arrive with an
 * empty `meta`. Its own reviews endpoint is the source that actually returns
 * the number. Fetch it after the WP pass and stamp the rating onto the
 * already-imported review destinations — a rating-only edit at the source is
 * invisible in the WP comment hash, so this pass runs on every import.
 */
const applyWooReviewRatings = async (ctx: Ctx, sawReview: boolean): Promise<void> => {
  if (!ctx.inventory?.hasWooCommerce) return
  if (!sawReview && !(await findByFields(ctx, 'comments', { commentType: 'review' }))) return

  const woo = ctx.clients.woo

  if (!woo) {
    await recordMigrationError(ctx.req, {
      code: 'WOO_REVIEW_RATINGS_UNAVAILABLE',
      error: new Error(
        'کلیدهای ووکامرس ثبت نشده‌اند؛ امتیاز بازخوردهای محصول از API ووکامرس خوانده نشد.',
      ),
      jobId: ctx.jobId,
      resource: 'comments',
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
    })
    ctx.counts.errors += 1
    return
  }

  try {
    for (const status of WOO_REVIEW_STATUSES) {
      const rows = await woo.collect<RawRecord>(WOO_PRODUCT_REVIEWS_PATH, {
        order: 'asc',
        orderby: 'id',
        status,
      })

      for (const row of rows) {
        const sourceRecordId = sourceRecordIdOf(row)
        const rating = commentRatingOf(row)
        if (!sourceRecordId || rating === null) continue

        const destinationId = await destinationIdFor(ctx, {
          collection: 'comments',
          resource: 'comments',
          sourceRecordId,
        })
        if (!destinationId) continue

        const doc = await findDestinationDoc(ctx, 'comments', destinationId)
        if (!doc || doc.commentType !== 'review' || doc.parent || doc.rating === rating) continue

        const updated = await updateDestinationDoc(ctx, {
          collection: 'comments',
          data: { rating },
          id: destinationId,
        })
        await refreshRecordDestination(
          ctx,
          'comments',
          sourceRecordId,
          isoOf(updated.updatedAt) || null,
        )
      }
    }

    await resolveMigrationErrors(ctx.req, {
      code: 'WOO_REVIEW_RATINGS_UNAVAILABLE',
      jobId: ctx.jobId,
      resource: 'comments',
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
    })
  } catch (error) {
    await recordMigrationError(ctx.req, {
      code:
        error instanceof MigrationImportError ? error.code : 'WOO_REVIEW_RATINGS_UNAVAILABLE',
      error,
      jobId: ctx.jobId,
      resource: 'comments',
      siteId: ctx.siteId,
      sourceId: ctx.sourceId,
    })
    ctx.counts.errors += 1
  }
}

export const importComments = async (ctx: Ctx): Promise<void> => {
  if (!ctx.settings.includeComments) return

  let sawReview = false

  for (const commentType of WORDPRESS_COMMENT_TYPES) {
    await processPages(ctx, {
      checkpointKey: `comments:${commentType}`,
      client: ctx.clients.wp,
      handler: async (raw) => {
        if ((str(raw.type) || commentType) === 'review') sawReview = true
        const sourceRecordId = sourceRecordIdOf(raw)!
        const contentRecord = asRecord(raw.content)
        const sourceBody = str(contentRecord.raw) || rendered(raw.content)
        const conversion = wordpressContentToLexical(sourceBody, { locale: ctx.settings.locale })

        if (!plainText(sourceBody)) {
          throw new MigrationImportError(
            'COMMENT_BODY_EMPTY',
            'متن دیدگاه خالی است؛ دیدگاه به‌صورت مسدود ثبت شد.',
            'blocked',
          )
        }

        const target = await commentTargetData(ctx, raw)
        const authorSourceId = intOf(raw.author, 0)
        let authorCustomer: null | string = null

        if (authorSourceId > 0) {
          authorCustomer = await destinationIdFor(ctx, {
            collection: 'customers',
            resource: 'customers',
            sourceRecordId: authorSourceId,
          }).catch(() => null)
        }

        const rating = commentRatingOf(raw)
        const result = await upsertDestination(ctx, {
          collection: 'comments',
          data: {
            // Source-owned optional fields are written explicitly, including
            // nulls. Omitting a now-empty email/URL/customer/rating from a
            // Payload update would preserve the previous destination value
            // forever, so a source-side removal would look like no change.
            authorCustomer,
            authorEmail: str(raw.author_email) || null,
            authorName:
              plainText(raw.author_name) || plainText(raw.reviewer) || 'نویسنده ناشناس',
            authorUrl: str(raw.author_url || raw.reviewer_url) || null,
            body: conversion.lexical,
            commentType: str(raw.type) || commentType,
            parent: null,
            rating,
            status: commentStatusOf(raw),
            submittedAt: dateOf(raw),
            targetCollection: target.collection,
            targetEntry: null,
            targetPage: null,
            targetPost: null,
            targetProduct: null,
            [target.field]: target.id,
            ...provenance(ctx, {
              raw,
              sourceRecordId,
              sourceType: str(raw.type) || commentType,
              system: 'wordpress',
            }),
          },
          metadata: {
            sourceParentId: intOf(raw.parent, 0),
            sourceStatus: str(raw.status),
            sourceTargetId: String(raw.post ?? ''),
          },
          raw,
          resource: 'comments',
          sourceRecordId,
        })

        if (intOf(raw.parent, 0) > 0) {
          ctx.pendingParents.push({
            collection: 'comments',
            destinationId: result.id,
            parentResource: 'comments',
            parentSourceRecordId: String(raw.parent),
            resource: 'comments',
            sourceRecordId,
          })
        }

        return actionDisposition(result.action)
      },
      params: {
        context: 'edit',
        order: 'asc',
        orderby: 'id',
        status: WORDPRESS_COMMENTS_STATUS,
        type: commentType,
      },
      path: WORDPRESS_COMMENTS_PATH,
      resource: 'comments',
    })
  }

  await linkPendingParents(ctx, 'comments')
  await applyWooReviewRatings(ctx, sawReview)
}

export const importCountsOf = (counts: MigrationCounts): MigrationCounts => counts
