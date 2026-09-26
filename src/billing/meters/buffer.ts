/**
 * Process-local aggregation for high-volume meters.
 *
 * A website request must not open an HTTP call to central Billing, and it must
 * not insert a financial row of its own. Counts sit here until `drainMeterBuffer`
 * hands them to the sample table. Losing the last few seconds on a hard crash
 * is the bound; once drained, the sample row is durable and the publisher is
 * what survives an outage of the billing platform.
 *
 * This buffer is not a second ledger. Two replicas each drain their own memory
 * into additive sample rows; the hourly outbox event is the sum.
 */

import { utcHourWindow } from '@/billing/meters/event-id'
import type { BillingMeterKey } from '@/billing/meters/registry'

export type BufferedMeasure = {
  at: string
  dimensions: Record<string, string>
  meterKey: BillingMeterKey
  quantity: number
  resourceId: null | string
  resourceType: null | string
  siteId: string
  source: string
  unit: string
}

const pending: BufferedMeasure[] = []

export const noteMeasure = (measure: BufferedMeasure): void => {
  if (!Number.isSafeInteger(measure.quantity) || measure.quantity <= 0) return
  pending.push(measure)
}

export const noteCustomerApiRequest = (siteId: string, at = new Date()): void => {
  const window = utcHourWindow(at)
  noteMeasure({
    at: at.toISOString(),
    dimensions: { source: 'site-api-key', windowEnd: window.end.toISOString() },
    meterKey: 'cms.api_request',
    quantity: 1,
    resourceId: null,
    resourceType: 'site',
    siteId,
    source: 'site-api-key',
    unit: 'request',
  })
}

export const noteOriginTransfer = (siteId: string, bytes: number, at = new Date()): void => {
  const window = utcHourWindow(at)
  noteMeasure({
    at: at.toISOString(),
    dimensions: { source: 'object-storage-proxy', windowEnd: window.end.toISOString() },
    meterKey: 'cms.origin_transfer_bytes',
    quantity: bytes,
    resourceId: null,
    resourceType: 'site',
    siteId,
    source: 'object-storage-proxy',
    unit: 'byte',
  })
}

export const meterBufferSize = (): number => pending.length

/** Take every buffered measure. The caller persists them; this process forgets them. */
export const drainMeterBuffer = (): BufferedMeasure[] => pending.splice(0, pending.length)

/**
 * Collapse a drain into one row per site, meter and UTC hour. Resource-scoped
 * measures (a single deployment) stay separate — they are not hourly sums.
 */
export const coalesceMeasures = (items: BufferedMeasure[]): BufferedMeasure[] => {
  const grouped = new Map<string, BufferedMeasure>()
  for (const item of items) {
    const hour = utcHourWindow(new Date(item.at)).start.toISOString()
    const key = `${item.siteId}|${item.meterKey}|${hour}|${item.resourceId ?? ''}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { ...item, at: hour, quantity: item.quantity })
      continue
    }
    existing.quantity += item.quantity
  }
  return [...grouped.values()]
}
