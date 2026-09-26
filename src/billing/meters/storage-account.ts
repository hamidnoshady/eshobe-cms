import type { PayloadRequest } from 'payload'

import { hourlyEventId } from '@/billing/meters/event-id'
import { advanceStorageClock, emptyStorageClock, storedObjectBytes, type StorageClock } from '@/billing/meters/storage-integral'
import type { UsageEventV1 } from '@/billing/contract/v1'
import { enqueueUsageEvent } from '@/billing/usage/outbox'

const clockFrom = (doc: Record<string, unknown> | null, at: number): StorageClock => {
  if (!doc) return emptyStorageClock(at, 0n)
  return {
    accruedByteMs: BigInt(String(doc.accruedByteMs ?? '0').replace(/[^\d-]/g, '') || '0'),
    accountedAt: Date.parse(String(doc.accountedAt ?? '')) || at,
    bytes: BigInt(Math.max(0, Math.trunc(Number(doc.bytes ?? 0)) || 0)),
    openHourStart: Date.parse(String(doc.openHourStart ?? '')) || at,
  }
}

const persist = async (req: PayloadRequest, siteId: string, id: null | string, state: StorageClock): Promise<void> => {
  const data = {
    accountedAt: new Date(state.accountedAt).toISOString(),
    accruedByteMs: state.accruedByteMs.toString(),
    bytes: Number(state.bytes),
    openHourStart: new Date(state.openHourStart).toISOString(),
    site: siteId,
  }
  if (!id) {
    await req.payload.create({
      collection: 'billing-storage-accounts',
      data,
      depth: 0,
      overrideAccess: true,
      req,
    })
    return
  }
  await req.payload.update({
    id,
    collection: 'billing-storage-accounts',
    data,
    depth: 0,
    overrideAccess: true,
    req,
  })
}

const emitClosed = async (req: PayloadRequest, siteId: string, closed: { byteHours: bigint; hourStart: number }[]) => {
  for (const hour of closed) {
    if (hour.byteHours <= 0n) continue
    if (hour.byteHours > BigInt(Number.MAX_SAFE_INTEGER)) {
      req.payload.logger.error({ msg: `storage byte-hours exceed a safe integer for site ${siteId}` })
      continue
    }
    const start = new Date(hour.hourStart)
    const event: UsageEventV1 = {
      actor: null,
      contractVersion: 1,
      correctsEventId: null,
      correctionReason: null,
      dimensions: { source: 'media-byte-integral' },
      eventId: hourlyEventId(siteId, 'cms.storage_byte_hour', start),
      kind: 'measurement',
      meterKey: 'cms.storage_byte_hour',
      occurredAt: new Date(hour.hourStart + 3_600_000).toISOString(),
      periodEnd: new Date(hour.hourStart + 3_600_000).toISOString(),
      periodStart: start.toISOString(),
      quantity: Number(hour.byteHours),
      resourceId: null,
      resourceType: 'site',
      siteId,
      unit: 'byte_hour',
    }
    await enqueueUsageEvent(req, event)
  }
}

export const applyStorageLevel = async (req: PayloadRequest, siteId: string, nextBytes: number, now = Date.now()): Promise<void> => {
  const { docs } = await req.payload.find({
    collection: 'billing-storage-accounts',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { site: { equals: siteId } },
  })
  const doc = (docs[0] as unknown as Record<string, unknown>) ?? null
  const advanced = advanceStorageClock(clockFrom(doc, now), now, BigInt(Math.max(0, Math.trunc(nextBytes))))
  await emitClosed(req, siteId, advanced.closed)
  await persist(req, siteId, doc ? String(doc.id) : null, advanced.state)
}

/** Close finished hours for every account without changing the byte level. */
export const flushStorageHours = async (req: PayloadRequest, now = Date.now()): Promise<number> => {
  const { docs } = await req.payload.find({
    collection: 'billing-storage-accounts',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
  })
  let flushed = 0
  for (const doc of docs as unknown as Record<string, unknown>[]) {
    const site = doc.site
    const siteId = typeof site === 'object' && site ? String((site as { id?: unknown }).id ?? '') : String(site ?? '')
    if (!siteId) continue
    const advanced = advanceStorageClock(clockFrom(doc, now), now)
    if (advanced.closed.length === 0) continue
    await emitClosed(req, siteId, advanced.closed)
    await persist(req, siteId, String(doc.id), advanced.state)
    flushed += advanced.closed.length
  }
  return flushed
}

export const storageBytesForSite = async (req: PayloadRequest, siteId: string): Promise<null | number> => {
  const { docs } = await req.payload.find({
    collection: 'billing-storage-accounts',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { site: { equals: siteId } },
  })
  const doc = docs[0] as { bytes?: unknown } | undefined
  if (!doc) return null
  const bytes = Number(doc.bytes ?? 0)
  return Number.isFinite(bytes) ? bytes : null
}

export { storedObjectBytes }
