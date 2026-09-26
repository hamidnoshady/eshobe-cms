import { randomUUID } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { parseUsageEvent, type UsageEventV1 } from '@/billing/contract/v1'
import { correctionEventId } from '@/billing/meters/event-id'
import { MAX_PUBLISH_ATTEMPTS, nextAttemptDelayMs } from '@/billing/usage/retry'

export const OUTBOX_BATCH = 50
const STALE_SENDING_MS = 10 * 60 * 1000

export type OutboxRow = {
  attemptCount: number
  eventId: string
  id: string
  kind: string
  leaseToken: null | string
  quantity: number
  status: string
}

const asRow = (doc: Record<string, unknown>): OutboxRow => ({
  attemptCount: Number(doc.attemptCount ?? 0) || 0,
  eventId: String(doc.eventId ?? ''),
  id: String(doc.id),
  kind: String(doc.kind ?? 'measurement'),
  leaseToken: typeof doc.leaseToken === 'string' ? doc.leaseToken : null,
  quantity: Number(doc.quantity ?? 0) || 0,
  status: String(doc.status ?? ''),
})

const eventData = (event: UsageEventV1, site: string) => ({
  actor: event.actor,
  correctsEventId: event.correctsEventId,
  correctionReason: event.correctionReason,
  dimensions: event.dimensions,
  eventId: event.eventId,
  kind: event.kind,
  meterKey: event.meterKey,
  occurredAt: event.occurredAt,
  periodEnd: event.periodEnd,
  periodStart: event.periodStart,
  quantity: event.quantity,
  resourceId: event.resourceId,
  resourceType: event.resourceType,
  site,
  status: 'pending' as const,
  unit: event.unit,
})

const findByEventId = async (req: PayloadRequest, eventId: string): Promise<null | OutboxRow & Record<string, unknown>> => {
  const { docs } = await req.payload.find({
    collection: 'billing-usage-outbox',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { eventId: { equals: eventId } },
  })
  const doc = docs[0] as unknown as Record<string, unknown> | undefined
  return doc ? { ...doc, ...asRow(doc) } : null
}

/**
 * Insert a validated event. A second insert of the same id updates a row that
 * central Billing has not accepted yet, and leaves an accepted row alone.
 */
export const enqueueUsageEvent = async (
  req: PayloadRequest,
  event: UsageEventV1,
): Promise<{ duplicate: boolean; id: string; status: string }> => {
  const parsed = parseUsageEvent(event)
  if ('error' in parsed) throw new Error(parsed.error.message)
  const existing = await findByEventId(req, event.eventId)
  if (!existing) {
    const created = await req.payload.create({
      collection: 'billing-usage-outbox',
      data: eventData(event, event.siteId),
      depth: 0,
      overrideAccess: true,
      req,
    })
    return { duplicate: false, id: String(created.id), status: 'pending' }
  }
  if (existing.status === 'sent' || existing.status === 'sending') {
    return { duplicate: true, id: existing.id, status: existing.status }
  }
  await req.payload.update({
    id: existing.id,
    collection: 'billing-usage-outbox',
    data: {
      ...eventData(event, event.siteId),
      attemptCount: existing.attemptCount,
      status: existing.status === 'dead_letter' ? 'dead_letter' : 'pending',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
  return { duplicate: true, id: existing.id, status: existing.status === 'dead_letter' ? 'dead_letter' : 'pending' }
}

/** When an accepted window grows, record the delta as a new event. Never edit the accepted row. */
export const enqueueCorrection = async (
  req: PayloadRequest,
  args: { actor: string; delta: number; original: UsageEventV1; reason: string },
): Promise<{ id: string }> => {
  const event: UsageEventV1 = {
    ...args.original,
    actor: args.actor,
    correctsEventId: args.original.eventId,
    correctionReason: args.reason,
    eventId: correctionEventId(args.original.eventId, args.delta),
    kind: 'correction',
    quantity: args.delta,
  }
  const result = await enqueueUsageEvent(req, event)
  return { id: result.id }
}

export const recoverStaleSending = async (req: PayloadRequest, now = Date.now()): Promise<number> => {
  const cutoff = new Date(now - STALE_SENDING_MS).toISOString()
  const { docs } = await req.payload.find({
    collection: 'billing-usage-outbox',
    depth: 0,
    limit: OUTBOX_BATCH,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [{ status: { equals: 'sending' } }, { lastAttemptAt: { less_than: cutoff } }],
    },
  })
  let recovered = 0
  for (const doc of docs as unknown as { id: unknown }[]) {
    await req.payload.update({
      id: String(doc.id),
      collection: 'billing-usage-outbox',
      data: { leaseToken: null, status: 'pending' },
      depth: 0,
      overrideAccess: true,
      req,
    })
    recovered += 1
  }
  return recovered
}

export const leaseOutboxBatch = async (req: PayloadRequest, now = new Date()): Promise<OutboxRow[]> => {
  const { docs } = await req.payload.find({
    collection: 'billing-usage-outbox',
    depth: 0,
    limit: OUTBOX_BATCH,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'createdAt',
    where: {
      and: [
        { status: { in: ['pending', 'failed'] } },
        {
          or: [{ nextAttemptAt: { exists: false } }, { nextAttemptAt: { less_than_equal: now.toISOString() } }],
        },
      ],
    },
  })
  const leased: OutboxRow[] = []
  for (const doc of docs as unknown as Record<string, unknown>[]) {
    const token = randomUUID()
    await req.payload.update({
      id: String(doc.id),
      collection: 'billing-usage-outbox',
      data: { lastAttemptAt: now.toISOString(), leaseToken: token, status: 'sending' },
      depth: 0,
      overrideAccess: true,
      req,
    })
    leased.push({ ...asRow(doc), leaseToken: token, status: 'sending' })
  }
  return leased
}

const stillLeased = async (req: PayloadRequest, row: OutboxRow): Promise<boolean> => {
  const current = await req.payload.findByID({
    id: row.id,
    collection: 'billing-usage-outbox',
    depth: 0,
    overrideAccess: true,
    req,
  })
  return (current as { leaseToken?: unknown }).leaseToken === row.leaseToken
}

export const markOutboxSent = async (req: PayloadRequest, row: OutboxRow, quantity: number): Promise<void> => {
  if (!(await stillLeased(req, row))) return
  await req.payload.update({
    id: row.id,
    collection: 'billing-usage-outbox',
    data: {
      exportedQuantity: quantity,
      lastError: null,
      leaseToken: null,
      sentAt: new Date().toISOString(),
      status: 'sent',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}

export const markOutboxRetry = async (
  req: PayloadRequest,
  row: OutboxRow,
  error: string,
  permanent: boolean,
): Promise<void> => {
  if (!(await stillLeased(req, row))) return
  const attemptCount = row.attemptCount + 1
  const dead = permanent || attemptCount >= MAX_PUBLISH_ATTEMPTS
  await req.payload.update({
    id: row.id,
    collection: 'billing-usage-outbox',
    data: {
      attemptCount,
      lastError: error.slice(0, 500),
      leaseToken: null,
      nextAttemptAt: dead ? null : new Date(Date.now() + nextAttemptDelayMs(attemptCount)).toISOString(),
      status: dead ? 'dead_letter' : 'failed',
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}

export const replayOutboxEvent = async (req: PayloadRequest, eventId: string): Promise<{ ok: boolean; status?: string }> => {
  const existing = await findByEventId(req, eventId)
  if (!existing) return { ok: false }
  if (existing.status === 'sent') return { ok: true, status: 'sent' }
  await req.payload.update({
    id: existing.id,
    collection: 'billing-usage-outbox',
    data: { leaseToken: null, nextAttemptAt: new Date().toISOString(), status: 'pending' },
    depth: 0,
    overrideAccess: true,
    req,
  })
  return { ok: true, status: 'pending' }
}

export const outboxEventToContract = (doc: Record<string, unknown>): UsageEventV1 => {
  const dimensions =
    doc.dimensions && typeof doc.dimensions === 'object' && !Array.isArray(doc.dimensions)
      ? Object.fromEntries(
          Object.entries(doc.dimensions as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
        )
      : {}
  return {
    actor: typeof doc.actor === 'string' ? doc.actor : null,
    contractVersion: 1,
    correctsEventId: typeof doc.correctsEventId === 'string' ? doc.correctsEventId : null,
    correctionReason: typeof doc.correctionReason === 'string' ? doc.correctionReason : null,
    dimensions,
    eventId: String(doc.eventId),
    kind: doc.kind === 'correction' ? 'correction' : 'measurement',
    meterKey: doc.meterKey as UsageEventV1['meterKey'],
    occurredAt: new Date(String(doc.occurredAt)).toISOString(),
    periodEnd: new Date(String(doc.periodEnd)).toISOString(),
    periodStart: new Date(String(doc.periodStart)).toISOString(),
    quantity: Number(doc.quantity),
    resourceId: typeof doc.resourceId === 'string' ? doc.resourceId : null,
    resourceType: typeof doc.resourceType === 'string' ? doc.resourceType : null,
    siteId: String((doc.site as { id?: string } | string | undefined) && typeof doc.site === 'object' ? (doc.site as { id: string }).id : doc.site),
    unit: String(doc.unit),
  }
}
