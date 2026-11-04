import type { CollectionSlug, PayloadRequest } from 'payload'

import type { MigrationJob, MigrationSource, Site } from '@/payload-types'
import { idOf } from '@/lib/ids'
import { htmlToPlainText } from '@/lib/html-text'
import { currencies, isCurrencyCode } from '@/lib/money'
import type { SourceInventory } from '@/lib/wordpress/discovery'
import type { CoverageRow } from '@/lib/wordpress/coverage'
import {
  contentHashOf,
  convertWooMoney,
  MappingError,
} from '@/lib/wordpress/mapping'

import { redactRawPayload, safeErrorMessage } from './redact'
import {
  findMigrationRecord,
  recordMigrationError,
  resolveMigrationErrors,
  sourceModifiedAtOf,
  sourceRecordIdOf,
  upsertMigrationRecord,
} from './records'
import {
  addCounts,
  emptyCounts,
  type DownloadedFile,
  type MediaDownloader,
  type MigrationCounts,
  type MigrationSettings,
  type RawRecord,
  type RecordDisposition,
  type SourceClients,
} from './types'

export type Loose = Record<string, unknown>

export const asRecord = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {}

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

export const str = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''

export const strOrNull = (value: unknown): null | string => {
  const text = str(value).trim()
  return text ? text : null
}

/**
 * Payload can hand timestamps back as ISO strings or `Date` objects depending
 * on the operation; rollback's untouched check must compare instants, not
 * whichever representation happened to arrive.
 */
export const isoOf = (value: unknown): string => {
  const time =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value).getTime()
        : Number.NaN

  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

export const num = (value: unknown): null | number => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

export const intOf = (value: unknown, fallback = 0): number => {
  const parsed = num(value)
  return parsed === null ? fallback : Math.trunc(parsed)
}

/** WP REST wraps rich fields as `{ rendered: '…' }`; accept a bare string too. */
export const rendered = (value: unknown): string =>
  typeof value === 'string' ? value : str(asRecord(value).rendered)

export const plainText = (value: unknown): string => htmlToPlainText(rendered(value))

export class MigrationImportError extends Error {
  code: string
  disposition: 'blocked' | 'error'

  constructor(code: string, message: string, disposition: 'blocked' | 'error' = 'error') {
    super(message)
    this.name = 'MigrationImportError'
    this.code = code
    this.disposition = disposition
  }
}

export class MigrationStoppedError extends Error {
  control: 'cancel' | 'pause'

  constructor(control: 'cancel' | 'pause') {
    super(control === 'pause' ? 'migration paused by operator' : 'migration cancelled by operator')
    this.name = 'MigrationStoppedError'
    this.control = control
  }
}

export type PendingParent = {
  collection: string
  destinationId: string
  parentResource: string
  parentSourceRecordId: string
  resource: string
  sourceRecordId: string
}

/**
 * One explicitly mapped ACF relationship field on one imported entry.
 * Content is imported before products (and before later CPTs in inventory
 * order), so the edge cannot be resolved inside the entry's own handler;
 * the specs ride in memory to the post-import relationship pass.
 */
export type PendingContentRelation = {
  entryId: string
  fieldKey: string
  relationTo: string
  sourceEntryRecordId: string
  sourceType: string
  value: unknown
}

export type MigrationContextState = {
  clients: SourceClients
  counts: MigrationCounts
  coverage: CoverageRow[]
  currentBatchId: null | string
  destinationCache: Map<string, null | string>
  download: MediaDownloader
  installation: string
  inventory: null | SourceInventory
  job: MigrationJob
  jobId: string
  mediaByUrl: Map<string, string>
  modifiedAfter: null | string
  operation: string
  pendingContentRelations: PendingContentRelation[]
  pendingParents: PendingParent[]
  perPage?: number
  req: PayloadRequest
  resume: boolean
  runId: string
  settings: MigrationSettings
  site: Site
  siteId: string
  source: MigrationSource
  sourceId: string
  startedAt: string
  taxonomyDefinitions: Map<string, Loose>
  typeDefinitions: Map<string, Loose>
}

export type Ctx = MigrationContextState

/** The job row's free-form settings + the site's store currency → one resolved run configuration. */
export const resolveMigrationSettings = async (
  req: PayloadRequest,
  job: MigrationJob,
  site: Site,
): Promise<MigrationSettings> => {
  const raw = asRecord(job.settings)
  const { docs } = await req.payload.find({
    collection: 'store',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { site: { equals: site.id } },
  })
  const storeCurrency = str((docs[0] as unknown as Loose | undefined)?.currency).toUpperCase()
  const targetCurrency =
    str(raw.targetCurrency).toUpperCase() || (isCurrencyCode(storeCurrency) ? storeCurrency : 'IRT')
  const localeCandidate = str(raw.locale)
  const locale = (site.availableLocales as string[]).includes(localeCandidate)
    ? localeCandidate
    : String(site.defaultLocale)

  return {
    applyRedirects: raw.applyRedirects !== false,
    confirmedRialToToman: raw.confirmedRialToToman === true,
    includeComments: raw.includeComments !== false,
    includeContent: raw.includeContent !== false,
    includeCoupons: raw.includeCoupons !== false,
    includeCustomers: raw.includeCustomers !== false,
    includeMedia: raw.includeMedia !== false,
    includeMenus: raw.includeMenus !== false,
    includeOrders: raw.includeOrders !== false,
    includeProducts: raw.includeProducts !== false,
    locale,
    sourceCurrency: str(raw.sourceCurrency).toUpperCase() || targetCurrency,
    sourceDecimals:
      typeof raw.sourceDecimals === 'number'
        ? raw.sourceDecimals
        : isCurrencyCode(targetCurrency)
          ? currencies[targetCurrency].minorDigits
          : 0,
    targetCurrency,
  }
}

/** Commerce resources only make sense on a store site, unless the owner explicitly opted in. */
export const commerceAllowed = (ctx: Ctx): boolean =>
  ctx.site.type === 'store' || asRecord(ctx.job.settings).allowCommerceOnNonStoreSite === true

export const money = (ctx: Ctx, value: unknown): number => {
  if (value === '' || value === null || value === undefined) return 0

  return convertWooMoney({
    confirmedRialToToman: ctx.settings.confirmedRialToToman,
    sourceCurrency: ctx.settings.sourceCurrency,
    sourceDecimals: ctx.settings.sourceDecimals,
    targetCurrency: ctx.settings.targetCurrency,
    value: value as number | string,
  })
}

export const updateJob = async (ctx: Ctx, data: Loose): Promise<MigrationJob> => {
  const updated = (await ctx.req.payload.update({
    id: ctx.jobId,
    collection: 'migration-jobs',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })) as MigrationJob
  ctx.job = updated

  return updated
}

export const updateSource = async (ctx: Ctx, data: Loose): Promise<MigrationSource> => {
  const updated = (await ctx.req.payload.update({
    id: ctx.sourceId,
    collection: 'migration-sources',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req: ctx.req,
  })) as MigrationSource
  ctx.source = updated

  return updated
}

const checkpointOf = (ctx: Ctx): Loose => asRecord(asRecord(ctx.job.checkpoint).resources)

export const saveCheckpoint = async (
  ctx: Ctx,
  resource: string,
  checkpoint: Loose,
): Promise<void> => {
  const resources = { ...checkpointOf(ctx), [resource]: checkpoint }

  await updateJob(ctx, {
    checkpoint: {
      operation: ctx.operation,
      resources,
      runId: ctx.runId,
      updatedAt: new Date().toISOString(),
    },
    counts: ctx.counts,
    lockedAt: new Date().toISOString(),
    phase: resource,
  })
}

/** Honor the operator's pause/cancel between pages and records. */
export const checkControl = async (ctx: Ctx): Promise<void> => {
  const fresh = (await ctx.req.payload.findByID({
    collection: 'migration-jobs',
    depth: 0,
    disableErrors: true,
    id: ctx.jobId,
    overrideAccess: true,
    req: ctx.req,
    select: { control: true },
  })) as null | { control?: string }

  if (fresh?.control === 'pause') throw new MigrationStoppedError('pause')
  if (fresh?.control === 'cancel') throw new MigrationStoppedError('cancel')
}

export const provenance = (
  ctx: Ctx,
  {
    raw,
    sourceRecordId,
    sourceType,
    system,
  }: { raw: RawRecord; sourceRecordId: number | string; sourceType: string; system: string },
): Loose => ({
  source: {
    contentHash: contentHashOf(redactRawPayload(raw)),
    installation: ctx.installation,
    mappingStatus: 'imported',
    modifiedAt: sourceModifiedAtOf(raw),
    permalink:
      typeof raw.link === 'string'
        ? raw.link
        : typeof raw.permalink === 'string'
          ? raw.permalink
          : null,
    rawPayload: redactRawPayload(raw),
    sourceAuthorId: raw.author === undefined ? null : String(raw.author),
    sourceId: String(sourceRecordId),
    sourceStatus: str(raw.status) || null,
    sourceType,
    system,
  },
})

export const findDestinationDoc = async (
  ctx: Ctx,
  collection: string,
  destinationId: null | string,
): Promise<Loose | null> => {
  if (!destinationId) return null

  const doc = (await ctx.req.payload.findByID({
    collection: collection as CollectionSlug,
    depth: 0,
    disableErrors: true,
    draft: true,
    id: destinationId,
    locale: ctx.settings.locale as never,
    overrideAccess: true,
    req: ctx.req,
  })) as unknown as Loose | null

  return doc && idOf(doc.site) === ctx.siteId ? doc : null
}

/**
 * Apply a small follow-up change (a parent link, product relations, today's
 * stock) without changing the destination's editorial state. Payload treats
 * an update with no `_status` on a draft-enabled collection as a new draft,
 * which would leave a published page/product publicly missing the very link
 * the importer just wrote; restating the current status keeps published
 * documents published and drafts drafts. Reads use `draft: true`, so the
 * returned `updatedAt` is the latest version's — the timestamp rollback
 * compares against to notice a later manual edit, draft edits included.
 */
export const updateDestinationDoc = async (
  ctx: Ctx,
  {
    collection,
    data,
    id,
  }: { collection: string; data: Loose; id: string },
): Promise<Loose> => {
  const existing = await findDestinationDoc(ctx, collection, id)
  if (!existing) throw new Error(`سند مقصد «${collection}/${id}» برای به‌روزرسانی پیدا نشد.`)

  const status = str(existing._status)
  const versioned = status === 'draft' || status === 'published'
  const updated = await ctx.req.payload.update({
    id,
    collection: collection as CollectionSlug,
    data: { ...data, ...(versioned ? { _status: status } : {}) } as never,
    depth: 0,
    ...(versioned ? { draft: status === 'draft' } : {}),
    locale: ctx.settings.locale as never,
    overrideAccess: true,
    req: ctx.req,
  } as never)

  return updated as unknown as Loose
}

/**
 * Resolve a source record to its destination id: ledger first, then the
 * destination's own provenance (a document an earlier partial import or a
 * manual repair already stamped). Adopting by provenance is what keeps a
 * re-created job from duplicating a catalogue its predecessor half-built.
 */
export const destinationIdFor = async (
  ctx: Ctx,
  {
    collection,
    resource,
    sourceRecordId,
  }: { collection: string; resource: string; sourceRecordId: number | string },
): Promise<null | string> => {
  const cacheKey = `${resource}:${String(sourceRecordId)}`
  if (ctx.destinationCache.has(cacheKey)) return ctx.destinationCache.get(cacheKey) ?? null

  const record = await findMigrationRecord(ctx.req, {
    installation: ctx.installation,
    jobId: ctx.jobId,
    resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId,
  })
  let destinationId = record?.destinationId ?? null

  if (destinationId && !(await findDestinationDoc(ctx, collection, destinationId))) {
    destinationId = null
  }

  if (!destinationId) {
    const { docs } = await ctx.req.payload.find({
      collection: collection as CollectionSlug,
      depth: 0,
      draft: true,
      limit: 1,
      overrideAccess: true,
      req: ctx.req,
      where: {
        and: [
          { site: { equals: ctx.siteId } },
          { 'source.installation': { equals: ctx.installation } },
          { 'source.sourceId': { equals: String(sourceRecordId) } },
        ],
      } as never,
    })
    destinationId = docs[0] ? String(docs[0].id) : null
  }

  // Cache only a positive resolution. A relationship target may legitimately
  // be imported by a later phase — and, for content entries/taxonomy terms,
  // under a more specific ledger resource than this generic lookup — so an
  // early miss must not become a permanent "not imported" answer.
  if (destinationId) ctx.destinationCache.set(cacheKey, destinationId)

  return destinationId
}

export type UpsertResult = {
  action: 'created' | 'unchanged' | 'updated'
  doc: Loose
  id: string
}

/**
 * The one destination write: create, update, or prove unchanged — always
 * keyed through the ledger, always stamped with the audited migration
 * context on `ctx.req`. The content hash decides "unchanged" *before* any
 * write, so a full re-run over a live source touches nothing it has already
 * imported faithfully.
 */
export const upsertDestination = async (
  ctx: Ctx,
  {
    adoptId,
    collection,
    contentHash,
    data,
    file,
    metadata,
    raw,
    resource,
    sourcePermalink,
    sourceRecordId,
    sourceSlug,
  }: {
    adoptId?: null | string
    collection: string
    contentHash?: string
    data: Loose
    file?: DownloadedFile
    metadata?: Loose
    raw: RawRecord
    resource: string
    sourcePermalink?: null | string
    sourceRecordId: number | string
    sourceSlug?: null | string
  },
): Promise<UpsertResult> => {
  const hash = contentHash ?? contentHashOf(redactRawPayload(raw))
  const identity = {
    installation: ctx.installation,
    jobId: ctx.jobId,
    resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId,
  }
  const existingRecord = await findMigrationRecord(ctx.req, identity)
  let existingId =
    adoptId ?? (await destinationIdFor(ctx, { collection, resource, sourceRecordId }))
  const writeData = { ...data, site: ctx.siteId }

  if (existingId && existingRecord?.contentHash === hash) {
    const doc = await findDestinationDoc(ctx, collection, existingId)

    // A matching *source* hash alone does not prove the destination is the
    // faithful copy the ledger last wrote: an editor may have changed the
    // staged document after import. WordPress remains the single writer
    // until cutover, so a destination whose timestamp has moved on falls
    // through to the update below and is rewritten from the source; only a
    // destination still at the ledger's timestamp may skip the write.
    const untouched =
      doc &&
      isoOf(existingRecord.destinationUpdatedAt) &&
      isoOf(doc.updatedAt) === isoOf(existingRecord.destinationUpdatedAt)

    if (!doc) {
      existingId = null
    } else if (untouched) {
      await upsertMigrationRecord(ctx.req, {
        ...identity,
        contentHash: hash,
        destinationCollection: collection,
        destinationId: existingId,
        destinationUpdatedAt: isoOf(doc.updatedAt) || null,
        disposition: 'unchanged',
        ...(metadata ? { metadata } : {}),
        raw,
        ...(sourcePermalink !== undefined ? { sourcePermalink } : {}),
        ...(sourceSlug !== undefined ? { sourceSlug } : {}),
      })
      await resolveMigrationErrors(ctx.req, {
        jobId: ctx.jobId,
        resource,
        siteId: ctx.siteId,
        sourceId: ctx.sourceId,
        sourceRecordId,
      })

      return { action: 'unchanged', doc, id: existingId }
    }
  }

  const doc = existingId
    ? ((await ctx.req.payload.update({
        id: existingId,
        collection: collection as CollectionSlug,
        data: writeData as never,
        depth: 0,
        ...(file ? { file } : {}),
        locale: ctx.settings.locale as never,
        overrideAccess: true,
        req: ctx.req,
      } as never)) as unknown as Loose)
    : ((await ctx.req.payload.create({
        collection: collection as CollectionSlug,
        data: writeData as never,
        depth: 0,
        ...(file ? { file } : {}),
        locale: ctx.settings.locale as never,
        overrideAccess: true,
        req: ctx.req,
      } as never)) as unknown as Loose)
  const id = String(doc.id)

  ctx.destinationCache.set(`${resource}:${String(sourceRecordId)}`, id)

  await upsertMigrationRecord(ctx.req, {
    ...identity,
    contentHash: hash,
    createdByMigration: existingRecord?.createdByMigration === true || !existingId,
    destinationCollection: collection,
    destinationId: id,
    destinationUpdatedAt: isoOf(doc.updatedAt) || null,
    disposition: existingId ? 'updated' : 'imported',
    ...(metadata ? { metadata } : {}),
    raw,
    ...(sourcePermalink !== undefined ? { sourcePermalink } : {}),
    ...(sourceSlug !== undefined ? { sourceSlug } : {}),
  })
  await resolveMigrationErrors(ctx.req, {
    jobId: ctx.jobId,
    resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId,
  })

  return { action: existingId ? 'updated' : 'created', doc, id }
}

const countKeyFor = (disposition: RecordDisposition): keyof MigrationCounts =>
  disposition === 'imported'
    ? 'imported'
    : disposition === 'updated'
      ? 'updated'
      : disposition === 'unchanged'
        ? 'unchanged'
        : disposition === 'archived'
          ? 'archived'
          : disposition === 'blocked'
            ? 'blocked'
            : 'errors'

/**
 * Stream one REST resource page by page through `handler`, with a batch row
 * and a durable checkpoint per page. A handler return is the record's
 * disposition; a throw becomes a ledger-backed error (or `blocked`) and the
 * run continues — one malformed source row must not strand the other ten
 * thousand, and it must not vanish either.
 */
export const processPages = async (
  ctx: Ctx,
  {
    checkpointKey,
    client,
    handler,
    params = {},
    path,
    resource,
    writeLedgerOnError = true,
  }: {
    /**
     * A single ledger resource can need several independently resumable
     * scans (WordPress comments are fetched once per comment type). Their
     * page cursors must not share the resource key, or resuming the second
     * scan would skip pages the first scan happened to finish.
     */
    checkpointKey?: string
    client: NonNullable<SourceClients['wp']>
    handler: (raw: RawRecord) => Promise<RecordDisposition>
    params?: Record<string, string>
    path: string
    resource: string
    writeLedgerOnError?: boolean
  },
): Promise<MigrationCounts> => {
  const totals = emptyCounts()
  const checkpointResource = checkpointKey ?? resource
  const checkpoint = asRecord(checkpointOf(ctx)[checkpointResource])
  const resumeThrough =
    ctx.resume && asRecord(ctx.job.checkpoint).operation === ctx.operation
      ? intOf(checkpoint.page, 0)
      : 0

  for await (const { items, page, totalPages } of client.pages<RawRecord>(path, params)) {
    if (page <= resumeThrough) continue

    await checkControl(ctx)

    const batchCounts = emptyCounts()
    const batch = (await ctx.req.payload.create({
      collection: 'migration-batches',
      data: {
        counts: batchCounts,
        job: ctx.jobId,
        page,
        resource,
        runId: ctx.runId,
        site: ctx.siteId,
        source: ctx.sourceId,
        startedAt: new Date().toISOString(),
        status: 'running',
      } as never,
      depth: 0,
      overrideAccess: true,
      req: ctx.req,
    })) as unknown as Loose
    const batchId = String(batch.id)
    ctx.currentBatchId = batchId

    try {
      for (const raw of items) {
        await checkControl(ctx)
        batchCounts.seen += 1
        const sourceRecordId = sourceRecordIdOf(raw)

        try {
          if (!sourceRecordId) {
            throw new MigrationImportError(
              'MISSING_SOURCE_ID',
              'رکورد مبدأ شناسه ندارد؛ بدون شناسه، ورود بدون تکرار ممکن نیست.',
            )
          }
          const disposition = await handler(raw)
          batchCounts[countKeyFor(disposition)] += 1
        } catch (error) {
          if (error instanceof MigrationStoppedError) throw error

          const blocked =
            error instanceof MigrationImportError && error.disposition === 'blocked'
          const code =
            error instanceof MigrationImportError || error instanceof MappingError
              ? error.code
              : 'IMPORT_ERROR'
          batchCounts[blocked ? 'blocked' : 'errors'] += 1

          if (writeLedgerOnError && sourceRecordId) {
            const record = await upsertMigrationRecord(ctx.req, {
              disposition: blocked ? 'blocked' : 'error',
              installation: ctx.installation,
              jobId: ctx.jobId,
              lastError: safeErrorMessage(error),
              raw,
              resource,
              siteId: ctx.siteId,
              sourceId: ctx.sourceId,
              sourceRecordId,
            })
            await recordMigrationError(ctx.req, {
              batchId,
              code,
              error,
              jobId: ctx.jobId,
              recordId: String(record.id),
              resource,
              retryable: !blocked,
              siteId: ctx.siteId,
              sourceId: ctx.sourceId,
              sourceRecordId,
            })
          } else if (writeLedgerOnError) {
            await recordMigrationError(ctx.req, {
              batchId,
              code,
              error,
              jobId: ctx.jobId,
              resource,
              siteId: ctx.siteId,
              sourceId: ctx.sourceId,
            })
          }
        }
      }

      await ctx.req.payload.update({
        id: batchId,
        collection: 'migration-batches',
        data: {
          counts: batchCounts,
          finishedAt: new Date().toISOString(),
          status: 'completed',
        } as never,
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })
      addCounts(totals, batchCounts)
      addCounts(ctx.counts, batchCounts)
      await saveCheckpoint(ctx, checkpointResource, {
        modifiedAfter: ctx.modifiedAfter,
        page,
        totalPages,
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      await ctx.req.payload.update({
        id: batchId,
        collection: 'migration-batches',
        data: {
          counts: batchCounts,
          error: safeErrorMessage(error),
          finishedAt: new Date().toISOString(),
          status:
            error instanceof MigrationStoppedError
              ? error.control === 'pause'
                ? 'paused'
                : 'cancelled'
              : 'failed',
        } as never,
        depth: 0,
        overrideAccess: true,
        req: ctx.req,
      })
      addCounts(totals, batchCounts)
      addCounts(ctx.counts, batchCounts)
      throw error
    } finally {
      ctx.currentBatchId = null
    }
  }

  return totals
}

export const recordDisposition = async (
  ctx: Ctx,
  {
    disposition,
    metadata,
    raw,
    resource,
    sourceRecordId,
  }: {
    disposition: RecordDisposition
    metadata?: Loose
    raw: RawRecord
    resource: string
    sourceRecordId: number | string
  },
): Promise<RecordDisposition> => {
  await upsertMigrationRecord(ctx.req, {
    disposition,
    installation: ctx.installation,
    jobId: ctx.jobId,
    ...(metadata ? { metadata } : {}),
    raw,
    resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId,
  })

  return disposition
}

/**
 * Dry-run ledger write: the row says `planned`, while the returned count
 * keeps the operator-facing would-create / would-update / unchanged meaning.
 * A record a real import already landed byte-for-byte is left exactly as it
 * is — a rehearsal must not downgrade history back to a plan.
 */
export const recordDryDisposition = async (
  ctx: Ctx,
  {
    metadata,
    raw,
    resource,
    sourceRecordId,
  }: {
    metadata?: Loose
    raw: RawRecord
    resource: string
    sourceRecordId: number | string
  },
): Promise<RecordDisposition> => {
  const existing = await findMigrationRecord(ctx.req, {
    installation: ctx.installation,
    jobId: ctx.jobId,
    resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId,
  })
  const hash = contentHashOf(redactRawPayload(raw))
  const settled = ['archived', 'imported', 'unchanged', 'updated'].includes(
    String(existing?.disposition),
  )

  if (existing && settled && existing.contentHash === hash) {
    return existing.disposition === 'archived' ? 'archived' : 'unchanged'
  }

  await upsertMigrationRecord(ctx.req, {
    disposition: 'planned',
    installation: ctx.installation,
    jobId: ctx.jobId,
    ...(metadata ? { metadata } : {}),
    raw,
    resource,
    siteId: ctx.siteId,
    sourceId: ctx.sourceId,
    sourceRecordId,
  })

  return existing?.destinationId ? 'updated' : 'imported'
}
