import type { PayloadRequest } from 'payload'

import type { MigrationRecord } from '@/payload-types'
import { contentHashOf, sourceRecordKey } from '@/lib/wordpress/mapping'

import { redactRawPayload, safeErrorMessage } from './redact'
import type { RawRecord, RecordDisposition } from './types'

/**
 * The only door to the migration ledger collections.
 *
 * Every importer write is preceded/followed by a row here, keyed by the
 * issue's idempotency quadruple `(site, installation, resource, source id)`.
 * Writing through these helpers — rather than ad-hoc `payload.create` calls
 * scattered over the engine — is what makes "zero duplicates on re-run" a
 * property of one function instead of a hope repeated at twenty call sites.
 * All writes run `overrideAccess` inside the importer's own request (the
 * collections refuse direct API writes); the tenant predicate is explicit
 * on every read anyway.
 */

export type LedgerIdentity = {
  installation: string
  jobId: string
  siteId: string
  sourceId: string
}

export const idempotencyKeyFor = (
  identity: LedgerIdentity & { resource: string; sourceRecordId: number | string },
): string =>
  sourceRecordKey({
    installation: identity.installation,
    resourceType: identity.resource,
    siteId: identity.siteId,
    sourceId: identity.sourceRecordId,
  })

export const sourceRecordIdOf = (raw: RawRecord): null | string => {
  const id = raw.id ?? raw.ID

  return typeof id === 'number' || (typeof id === 'string' && id.trim()) ? String(id) : null
}

/** The sortable instant a source record last changed, for delta queries and stale checks. */
export const sourceModifiedAtOf = (raw: RawRecord): null | string => {
  const candidates = [
    raw.modified_gmt,
    raw.modified,
    raw.date_modified_gmt,
    raw.date_modified,
    raw.date_gmt,
    raw.date_created_gmt,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      const withZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(candidate) ? candidate : `${candidate}Z`
      const time = Date.parse(withZone)
      if (Number.isFinite(time)) return new Date(time).toISOString()
    }
  }

  return null
}

export const findMigrationRecord = async (
  req: PayloadRequest,
  identity: LedgerIdentity & { resource: string; sourceRecordId: number | string },
): Promise<MigrationRecord | null> => {
  const { docs } = await req.payload.find({
    collection: 'migration-records',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: identity.siteId } },
        { idempotencyKey: { equals: idempotencyKeyFor(identity) } },
      ],
    },
  })

  return (docs[0] as MigrationRecord | undefined) ?? null
}

export type MigrationRecordWrite = LedgerIdentity & {
  contentHash?: string
  createdByMigration?: boolean
  destinationCollection?: null | string
  destinationId?: null | string
  destinationUpdatedAt?: null | string
  disposition: RecordDisposition
  lastError?: null | string
  metadata?: Record<string, unknown>
  raw?: RawRecord
  resource: string
  sourcePermalink?: null | string
  sourceRecordId: number | string
  sourceSlug?: null | string
}

export const upsertMigrationRecord = async (
  req: PayloadRequest,
  write: MigrationRecordWrite,
): Promise<MigrationRecord> => {
  const key = idempotencyKeyFor(write)
  const existing = await findMigrationRecord(req, write)
  const raw = write.raw
  const data: Record<string, unknown> = {
    attempts: Number(existing?.attempts ?? 0) + 1,
    contentHash:
      write.contentHash ?? (raw ? contentHashOf(redactRawPayload(raw)) : existing?.contentHash),
    createdByMigration: write.createdByMigration ?? existing?.createdByMigration ?? false,
    destinationCollection: write.destinationCollection ?? existing?.destinationCollection ?? null,
    destinationId: write.destinationId ?? existing?.destinationId ?? null,
    destinationUpdatedAt: write.destinationUpdatedAt ?? existing?.destinationUpdatedAt ?? null,
    disposition: write.disposition,
    idempotencyKey: key,
    installation: write.installation,
    job: write.jobId,
    lastError: write.disposition === 'error' ? (write.lastError ?? null) : null,
    metadata: write.metadata ? redactRawPayload(write.metadata) : (existing?.metadata ?? null),
    rawPayload: raw ? redactRawPayload(raw) : undefined,
    resource: write.resource,
    site: write.siteId,
    source: write.sourceId,
    sourceModifiedAt: raw ? sourceModifiedAtOf(raw) : existing?.sourceModifiedAt,
    sourcePermalink:
      write.sourcePermalink ??
      (typeof raw?.link === 'string'
        ? raw.link
        : typeof raw?.permalink === 'string'
          ? raw.permalink
          : existing?.sourcePermalink),
    sourceRecordId: String(write.sourceRecordId),
    sourceSlug:
      write.sourceSlug ?? (typeof raw?.slug === 'string' ? raw.slug : existing?.sourceSlug),
  }

  if (!existing) {
    return (await req.payload.create({
      collection: 'migration-records',
      data: data as never,
      depth: 0,
      overrideAccess: true,
      req,
    })) as MigrationRecord
  }

  return (await req.payload.update({
    id: existing.id,
    collection: 'migration-records',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as MigrationRecord
}

export const recordMigrationEvent = async (
  req: PayloadRequest,
  {
    details,
    eventType,
    jobId,
    level = 'info',
    message,
    resource,
    siteId,
    sourceId,
    sourceRecordId,
  }: {
    details?: Record<string, unknown>
    eventType: string
    jobId?: string
    level?: 'error' | 'info' | 'warning'
    message: string
    resource?: string
    siteId: string
    sourceId?: string
    sourceRecordId?: string
  },
): Promise<void> => {
  await req.payload.create({
    collection: 'migration-events',
    data: {
      ...(details ? { details: redactRawPayload(details) as Record<string, unknown> } : {}),
      eventType,
      ...(jobId ? { job: jobId } : {}),
      level,
      message: message.slice(0, 2_000),
      ...(resource ? { resource } : {}),
      site: siteId,
      ...(sourceId ? { source: sourceId } : {}),
      ...(sourceRecordId ? { sourceRecordId } : {}),
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
}

export const recordMigrationError = async (
  req: PayloadRequest,
  {
    batchId,
    code,
    details,
    error,
    jobId,
    recordId,
    resource,
    retryable = true,
    siteId,
    sourceId,
    sourceRecordId,
  }: {
    batchId?: string
    code: string
    details?: Record<string, unknown>
    error: unknown
    jobId?: string
    recordId?: string
    resource?: string
    retryable?: boolean
    siteId: string
    sourceId?: string
    sourceRecordId?: string
  },
): Promise<void> => {
  const message = safeErrorMessage(error)

  const { docs } = await req.payload.find({
    collection: 'migration-errors',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        ...(jobId ? [{ job: { equals: jobId } }] : []),
        { code: { equals: code } },
        ...(resource ? [{ resource: { equals: resource } }] : []),
        ...(sourceRecordId ? [{ sourceRecordId: { equals: sourceRecordId } }] : []),
        { status: { equals: 'open' } },
      ],
    },
  })
  const existing = docs[0] as { attempts?: number | null; id: string } | undefined
  const data = {
    attempts: Number(existing?.attempts ?? 0) + 1,
    ...(batchId ? { batch: batchId } : {}),
    code,
    ...(details ? { details: redactRawPayload(details) as Record<string, unknown> } : {}),
    ...(jobId ? { job: jobId } : {}),
    message,
    ...(recordId ? { record: recordId } : {}),
    ...(resource ? { resource } : {}),
    retryable,
    site: siteId,
    ...(sourceId ? { source: sourceId } : {}),
    ...(sourceRecordId ? { sourceRecordId } : {}),
    status: 'open',
  }

  if (existing) {
    await req.payload.update({
      id: existing.id,
      collection: 'migration-errors',
      data: data as never,
      depth: 0,
      overrideAccess: true,
      req,
    })
    return
  }

  await req.payload.create({
    collection: 'migration-errors',
    data: data as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
}

/**
 * Close open errors a later successful write or gate decision has superseded.
 * Without this, reconciliation's "zero open errors" gate would be a one-way
 * door: a record that failed once and then imported cleanly on retry (or a
 * cutover refused only because the write fence was not confirmed yet) would
 * block cutover forever, long after the underlying fact changed.
 */
export const resolveMigrationErrors = async (
  req: PayloadRequest,
  {
    code,
    jobId,
    resource,
    siteId,
    sourceId,
    sourceRecordId,
  }: {
    code?: string
    jobId?: string
    resource?: string
    siteId: string
    sourceId?: string
    sourceRecordId?: number | string
  },
): Promise<number> => {
  const { docs } = await req.payload.find({
    collection: 'migration-errors',
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        { site: { equals: siteId } },
        ...(sourceId ? [{ source: { equals: sourceId } }] : []),
        ...(jobId ? [{ job: { equals: jobId } }] : []),
        ...(code ? [{ code: { equals: code } }] : []),
        ...(resource ? [{ resource: { equals: resource } }] : []),
        ...(sourceRecordId !== undefined
          ? [{ sourceRecordId: { equals: String(sourceRecordId) } }]
          : []),
        { status: { equals: 'open' } },
      ],
    } as never,
  })

  for (const doc of docs) {
    await req.payload.update({
      id: doc.id,
      collection: 'migration-errors',
      data: { status: 'resolved' } as never,
      depth: 0,
      overrideAccess: true,
      req,
    })
  }

  return docs.length
}

export const recordMigrationAudit = async (
  req: PayloadRequest,
  {
    action,
    actorId,
    details,
    jobId,
    siteId,
    sourceId,
    summary,
  }: {
    action: string
    actorId?: null | string
    details?: Record<string, unknown>
    jobId?: string
    siteId: string
    sourceId?: string
    summary: string
  },
): Promise<void> => {
  await req.payload.create({
    collection: 'migration-audits',
    data: {
      action,
      ...(actorId ? { actor: actorId } : {}),
      ...(details ? { details: redactRawPayload(details) as Record<string, unknown> } : {}),
      ...(jobId ? { job: jobId } : {}),
      site: siteId,
      ...(sourceId ? { source: sourceId } : {}),
      summary: summary.slice(0, 2_000),
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
}
