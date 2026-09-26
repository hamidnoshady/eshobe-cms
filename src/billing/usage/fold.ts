import type { PayloadRequest } from 'payload'

import type { UsageEventV1 } from '@/billing/contract/v1'
import { hourlyEventId, utcHourWindow } from '@/billing/meters/event-id'
import { meterByKey, type BillingMeterKey } from '@/billing/meters/registry'
import { coalesceMeasures, drainMeterBuffer, type BufferedMeasure } from '@/billing/meters/buffer'
import { enqueueCorrection, enqueueUsageEvent } from '@/billing/usage/outbox'

const persistSamples = async (req: PayloadRequest, measures: BufferedMeasure[]): Promise<number> => {
  let written = 0
  for (const measure of coalesceMeasures(measures)) {
    const window = utcHourWindow(new Date(measure.at))
    await req.payload.create({
      collection: 'billing-usage-samples',
      data: {
        dimensions: measure.dimensions,
        meterKey: measure.meterKey,
        occurredAt: measure.at,
        periodEnd: window.end.toISOString(),
        periodStart: window.start.toISOString(),
        quantity: measure.quantity,
        resourceId: measure.resourceId,
        resourceType: measure.resourceType,
        site: measure.siteId,
        source: measure.source,
        unit: measure.unit,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
    written += 1
  }
  return written
}

/** Drain this process's buffer into durable samples. Safe to call from any replica. */
export const flushMeterBuffer = async (req: PayloadRequest): Promise<number> => persistSamples(req, drainMeterBuffer())

type Group = { meterKey: BillingMeterKey; periodEnd: string; periodStart: string; quantity: number; siteId: string; unit: string }

export const foldSamplesIntoOutbox = async (req: PayloadRequest, limit = 500): Promise<number> => {
  const horizon = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const { docs } = await req.payload.find({
    collection: 'billing-usage-samples',
    depth: 0,
    limit,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'periodStart',
    where: { periodStart: { greater_than_equal: horizon } },
  })
  const groups = new Map<string, Group>()
  for (const doc of docs as unknown as Record<string, unknown>[]) {
    const site = doc.site
    const siteId = typeof site === 'object' && site ? String((site as { id?: unknown }).id ?? '') : String(site ?? '')
    const meterKey = String(doc.meterKey ?? '') as BillingMeterKey
    const periodStart = new Date(String(doc.periodStart ?? '')).toISOString()
    if (!siteId || !meterKey) continue
    const key = `${siteId}|${meterKey}|${periodStart}`
    const quantity = Number(doc.quantity ?? 0) || 0
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, {
        meterKey,
        periodEnd: new Date(String(doc.periodEnd ?? '')).toISOString(),
        periodStart,
        quantity,
        siteId,
        unit: String(doc.unit ?? meterByKey(meterKey).unit),
      })
    } else existing.quantity += quantity
  }

  let folded = 0
  for (const group of groups.values()) {
    const meter = meterByKey(group.meterKey)
    const event: UsageEventV1 = {
      actor: null,
      contractVersion: 1,
      correctsEventId: null,
      correctionReason: null,
      dimensions: { source: meter.source },
      eventId: hourlyEventId(group.siteId, group.meterKey, new Date(group.periodStart)),
      kind: 'measurement',
      meterKey: group.meterKey,
      occurredAt: group.periodEnd,
      periodEnd: group.periodEnd,
      periodStart: group.periodStart,
      quantity: group.quantity,
      resourceId: null,
      resourceType: 'site',
      siteId: group.siteId,
      unit: meter.unit,
    }
    const { docs: existing } = await req.payload.find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { eventId: { equals: event.eventId } },
    })
    const row = existing[0] as { exportedQuantity?: unknown; quantity?: unknown; status?: unknown } | undefined
    if (row?.status === 'sent') {
      const accepted = Number(row.exportedQuantity ?? row.quantity ?? 0) || 0
      const delta = group.quantity - accepted
      if (delta !== 0) {
        await enqueueCorrection(req, {
          actor: 'cms-fold',
          delta,
          original: event,
          reason: 'نمونه‌های تازه‌تر از پنجرهٔ پذیرفته‌شده رسید.',
        })
      }
    } else {
      await enqueueUsageEvent(req, event)
    }
    folded += 1
  }
  return folded
}
