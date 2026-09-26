/**
 * billing-contract/v1 — the only shape eshobe-cms exchanges with central Billing.
 *
 * CMS reports quantities. It does not report a business, a price, a wallet, or an
 * invoice. Central Billing maps `siteId` to a business through its own
 * `eshobe_cms_connections` table; a field for that mapping is not part of this
 * contract, and a payload that carries one is rejected so a compromised CMS
 * cannot choose who gets charged.
 */

import { isBillingMeterKey, meterByKey, type BillingMeterKey } from '@/billing/meters/registry'

export const CONTRACT_NAMESPACE = 'billing-contract/v1' as const
export const CONTRACT_VERSION = 1 as const
export const USAGE_SOURCE = 'eshobe-cms' as const

export type UsageKind = 'measurement' | 'correction'

export type UsageEventV1 = {
  actor: null | string
  contractVersion: typeof CONTRACT_VERSION
  correctsEventId: null | string
  correctionReason: null | string
  dimensions: Record<string, string>
  eventId: string
  kind: UsageKind
  meterKey: BillingMeterKey
  occurredAt: string
  periodEnd: string
  periodStart: string
  quantity: number
  resourceId: null | string
  resourceType: null | string
  siteId: string
  unit: string
}

export type UsageBatchV1 = {
  contractVersion: typeof CONTRACT_VERSION
  events: UsageEventV1[]
  source: typeof USAGE_SOURCE
}

const FORBIDDEN_KEYS = [
  'amount',
  'businessid',
  'business_id',
  'credit',
  'currency',
  'invoice',
  'price',
  'wallet',
] as const

const ISO = (value: unknown): null | string => {
  if (typeof value !== 'string' || !value.trim()) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toISOString()
}

const stringDimensions = (value: unknown): Record<string, string> | null => {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9._-]{1,64}$/i.test(key)) return null
    if (typeof raw !== 'string' || raw.length > 200) return null
    out[key] = raw
  }
  return out
}

export type ContractError = { message: string; path: string }

/** Reject anything that is not a v1 measurement. Unknown meters fail closed. */
export const parseUsageEvent = (input: unknown): { error: ContractError } | { event: UsageEventV1 } => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { message: 'رویداد مصرف باید یک شیء باشد.', path: '' } }
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase() as (typeof FORBIDDEN_KEYS)[number])) {
      return { error: { message: 'قرارداد مصرف قیمت، کیف پول یا شناسهٔ کسب‌وکار را حمل نمی‌کند.', path: key } }
    }
  }

  if (raw.contractVersion !== undefined && raw.contractVersion !== CONTRACT_VERSION) {
    return { error: { message: 'نسخهٔ قرارداد پشتیبانی نمی‌شود.', path: 'contractVersion' } }
  }
  if (typeof raw.eventId !== 'string' || !/^[a-zA-Z0-9:._-]{8,200}$/.test(raw.eventId)) {
    return { error: { message: 'شناسهٔ رویداد نامعتبر است.', path: 'eventId' } }
  }
  if (typeof raw.siteId !== 'string' || raw.siteId.length < 8) {
    return { error: { message: 'شناسهٔ سایت نامعتبر است.', path: 'siteId' } }
  }
  if (!isBillingMeterKey(raw.meterKey)) {
    return { error: { message: 'سنجهٔ صورت‌حساب ناشناخته است.', path: 'meterKey' } }
  }
  const meter = meterByKey(raw.meterKey)
  if (!meter.export) {
    return { error: { message: 'این سنجه برای ارسال مالی فعال نیست.', path: 'meterKey' } }
  }
  if (raw.unit !== meter.unit) {
    return { error: { message: `واحد «${meter.unit}» برای این سنجه لازم است.`, path: 'unit' } }
  }

  const kind: UsageKind = raw.kind === 'correction' ? 'correction' : 'measurement'
  const quantity = raw.quantity
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity)) {
    return { error: { message: 'مقدار باید یک عدد صحیح امن باشد.', path: 'quantity' } }
  }
  if (kind === 'measurement' && quantity <= 0) {
    return { error: { message: 'مقدار اندازه‌گیری باید مثبت باشد.', path: 'quantity' } }
  }
  if (kind === 'correction' && quantity === 0) {
    return { error: { message: 'اصلاحیه نمی‌تواند صفر باشد.', path: 'quantity' } }
  }

  const periodStart = ISO(raw.periodStart)
  const periodEnd = ISO(raw.periodEnd)
  const occurredAt = ISO(raw.occurredAt)
  if (!periodStart || !periodEnd || !occurredAt) {
    return { error: { message: 'بازهٔ زمانی رویداد نامعتبر است.', path: 'periodStart' } }
  }
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) {
    return { error: { message: 'پایان دوره باید بعد از شروع آن باشد.', path: 'periodEnd' } }
  }

  const dimensions = stringDimensions(raw.dimensions)
  if (!dimensions) return { error: { message: 'ابعاد رویداد باید رشته باشند.', path: 'dimensions' } }

  const correctsEventId = typeof raw.correctsEventId === 'string' ? raw.correctsEventId : null
  const correctionReason = typeof raw.correctionReason === 'string' ? raw.correctionReason.slice(0, 500) : null
  const actor = typeof raw.actor === 'string' ? raw.actor.slice(0, 120) : null
  if (kind === 'correction' && (!correctsEventId || !correctionReason || !actor)) {
    return {
      error: {
        message: 'اصلاحیه به شناسهٔ رویداد قبلی، دلیل و منبع نیاز دارد.',
        path: 'correctsEventId',
      },
    }
  }

  return {
    event: {
      actor: kind === 'correction' ? actor : null,
      contractVersion: CONTRACT_VERSION,
      correctsEventId: kind === 'correction' ? correctsEventId : null,
      correctionReason: kind === 'correction' ? correctionReason : null,
      dimensions,
      eventId: raw.eventId,
      kind,
      meterKey: raw.meterKey,
      occurredAt,
      periodEnd,
      periodStart,
      quantity,
      resourceId: typeof raw.resourceId === 'string' ? raw.resourceId.slice(0, 200) : null,
      resourceType: typeof raw.resourceType === 'string' ? raw.resourceType.slice(0, 64) : null,
      siteId: raw.siteId,
      unit: meter.unit,
    },
  }
}

export const parseUsageBatch = (
  input: unknown,
): { batch: UsageBatchV1 } | { error: ContractError } => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { message: 'بدنهٔ دسته باید یک شیء باشد.', path: '' } }
  }
  const raw = input as Record<string, unknown>
  if (raw.source !== USAGE_SOURCE) {
    return { error: { message: 'منبع دسته باید eshobe-cms باشد.', path: 'source' } }
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    return { error: { message: 'نسخهٔ قرارداد پشتیبانی نمی‌شود.', path: 'contractVersion' } }
  }
  if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > 100) {
    return { error: { message: 'دسته باید بین ۱ و ۱۰۰ رویداد داشته باشد.', path: 'events' } }
  }
  const events: UsageEventV1[] = []
  for (const [index, item] of raw.events.entries()) {
    const parsed = parseUsageEvent(item)
    if ('error' in parsed) return { error: { ...parsed.error, path: `events[${index}].${parsed.error.path}` } }
    events.push(parsed.event)
  }
  return { batch: { contractVersion: CONTRACT_VERSION, events, source: USAGE_SOURCE } }
}
