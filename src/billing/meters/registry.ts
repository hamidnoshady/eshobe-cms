/**
 * The closed CMS billing-meter catalogue.
 *
 * A string that is not in this table is not a billable meter. Quota metrics
 * (`pages`, `products`, …) live in `src/lib/saas/plans.ts` and are a different
 * type on purpose: a product limit is not a quantity central Billing prices.
 *
 * `collection` says where a number is allowed to come from.
 *  - `measured` — this process records it from a technical event it can see.
 *  - `ingest` — only an authenticated producer may submit it. CMS does not invent it.
 */

export const BILLING_METERS = [
  {
    aggregation: 'sum',
    collection: 'measured',
    export: true,
    key: 'cms.api_request',
    resource: 'site',
    source: 'site-api-key',
    unit: 'request',
  },
  {
    aggregation: 'sum',
    collection: 'measured',
    export: true,
    key: 'cms.origin_transfer_bytes',
    resource: 'site',
    source: 'object-storage-proxy',
    unit: 'byte',
  },
  {
    aggregation: 'sum',
    collection: 'ingest',
    export: true,
    key: 'cms.bandwidth_bytes',
    resource: 'site',
    source: 'external-edge',
    unit: 'byte',
  },
  {
    aggregation: 'sum',
    collection: 'measured',
    export: true,
    key: 'cms.storage_byte_hour',
    resource: 'site',
    source: 'media-byte-integral',
    unit: 'byte_hour',
  },
  {
    aggregation: 'sum',
    collection: 'measured',
    export: true,
    key: 'cms.deployment',
    resource: 'deployment',
    source: 'deployment-promoted',
    unit: 'deployment',
  },
  {
    aggregation: 'sum',
    collection: 'ingest',
    export: true,
    key: 'cms.build_second',
    resource: 'build',
    source: 'external-build',
    unit: 'second',
  },
] as const

export type BillingMeter = (typeof BILLING_METERS)[number]
export type BillingMeterKey = BillingMeter['key']
export type BillingUnit = BillingMeter['unit']

export const BILLING_METER_KEYS = BILLING_METERS.map((meter) => meter.key)

export const isBillingMeterKey = (value: unknown): value is BillingMeterKey =>
  typeof value === 'string' && BILLING_METER_KEYS.includes(value as BillingMeterKey)

export const meterByKey = (key: BillingMeterKey): BillingMeter => {
  const meter = BILLING_METERS.find((item) => item.key === key)
  if (!meter) throw new Error(`unknown billing meter ${key}`)
  return meter
}

/** Meters this process records itself. Ingest-only meters stay out of automatic collectors. */
export const MEASURED_METERS = BILLING_METERS.filter((meter) => meter.collection === 'measured')
