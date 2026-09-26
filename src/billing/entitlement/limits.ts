/**
 * Limit clauses that cross the service boundary.
 *
 * Absent, zero and null are not interchangeable here. A projection states each
 * opinion explicitly. `normalizeLimit` in the quota module still treats a
 * missing number as unlimited *after* this clause has been applied — that is
 * the local enforcement representation, not the contract.
 */

import { QUOTA_METRICS, type QuotaLimits, type QuotaMetric } from '@/lib/saas/plans'

export type LimitClause = { state: 'limit'; value: number } | { state: 'unlimited' }

export type LimitMap = Partial<Record<QuotaMetric, LimitClause>>

export const parseLimitMap = (input: unknown): { error: string } | { limits: LimitMap } => {
  if (input == null) return { limits: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'سقف‌ها باید یک شیء باشند.' }
  const limits: LimitMap = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(QUOTA_METRICS as readonly string[]).includes(key)) {
      return { error: `سنجهٔ سقف ناشناخته: ${key}` }
    }
    const metric = key as QuotaMetric
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `بند سقف «${key}» نامعتبر است.` }
    const clause = raw as { state?: unknown; value?: unknown }
    if (clause.state === 'unlimited') {
      limits[metric] = { state: 'unlimited' }
      continue
    }
    if (clause.state === 'limit') {
      if (typeof clause.value !== 'number' || !Number.isSafeInteger(clause.value) || clause.value <= 0) {
        return { error: `مقدار سقف «${key}» باید یک عدد صحیح مثبت باشد.` }
      }
      limits[metric] = { state: 'limit', value: clause.value }
      continue
    }
    return { error: `وضعیت سقف «${key}» باید limit یا unlimited باشد.` }
  }
  return { limits }
}

/** Local quota map. Unspecified metrics are omitted, which enforcement reads as unlimited. */
export const limitsToQuota = (limits: LimitMap): QuotaLimits => {
  const out: QuotaLimits = {}
  for (const metric of QUOTA_METRICS) {
    const clause = limits[metric]
    if (!clause || clause.state === 'unlimited') continue
    out[metric] = clause.value
  }
  return out
}

export const quotaToLimits = (limits: QuotaLimits): LimitMap => {
  const out: LimitMap = {}
  for (const metric of QUOTA_METRICS) {
    const value = limits[metric]
    if (typeof value === 'number' && value > 0) out[metric] = { state: 'limit', value: Math.trunc(value) }
    else out[metric] = { state: 'unlimited' }
  }
  return out
}

export type VersionDecision = 'accept' | 'idempotent' | 'stale'

/** A projection version only moves forward. Equality is a retry, not an edit. */
export const decideProjectionVersion = (current: null | number, incoming: number): VersionDecision => {
  if (!Number.isSafeInteger(incoming) || incoming < 1) return 'stale'
  if (current == null) return 'accept'
  if (incoming > current) return 'accept'
  if (incoming === current) return 'idempotent'
  return 'stale'
}
