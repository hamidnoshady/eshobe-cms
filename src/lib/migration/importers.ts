import { isMachineKey, isValidArchiveSlug } from '@/lib/content-paths'
import { idOf } from '@/lib/ids'
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
  commerceAllowed,
  destinationIdFor,
  findDestinationDoc,
  intOf,
  isoOf,
  MigrationImportError,
  money,
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
import { recordMigrationError, recordMigrationEvent, sourceRecordIdOf } from './records'
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
          ? { slug, title: name }
          : {
              description: plainText(raw.description),
              legacyArchiveUrl: str(raw.link) || null,
              meta: raw.meta ? redactRawPayload(raw.meta) : null,
              name,
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
      // A bare source id does not name its destination collection; keep it
      // visible for a later mapping instead of guessing a target.
      unmapped[key] = redactRawPayload(value)
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
            const syntheticId = `${sourceRecordId}:${taxonomy.slug}:${String(termSourceId)}`

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

            const relRaw: RawRecord = {
              entry: sourceRecordId,
              id: syntheticId,
              taxonomy: taxonomy.slug,
              term: termSourceId,
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

export const importCountsOf = (counts: MigrationCounts): MigrationCounts => counts
