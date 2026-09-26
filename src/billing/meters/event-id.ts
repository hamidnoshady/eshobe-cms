/**
 * Deterministic event ids. Regenerating the same window or the same deployment
 * must name the same logical event, so central Billing can treat a retry as a
 * duplicate instead of a second charge.
 */

import type { BillingMeterKey } from '@/billing/meters/registry'

/** UTC hour containing `at`, `[start, end)`. */
export const utcHourWindow = (at: Date): { end: Date; start: Date } => {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours()))
  return { end: new Date(start.getTime() + 60 * 60 * 1000), start }
}

const meterSlug = (key: BillingMeterKey): string => {
  if (key.startsWith('cms.')) return key.slice(4).replaceAll('.', '_')
  if (key.startsWith('media.')) return `media_${key.slice(6).replaceAll('.', '_')}`
  return key.replaceAll('.', '_')
}

/** `cms:<site>:api_request:<hour>` — one financial event per site, meter and hour. */
export const hourlyEventId = (siteId: string, meter: BillingMeterKey, hourStart: Date): string =>
  `cms:${siteId}:${meterSlug(meter)}:${utcHourWindow(hourStart).start.toISOString()}`

/** `cms:<deploymentId>:deployment` — one event per deployment row, not per retry. */
export const deploymentEventId = (deploymentId: string): string => `cms:${deploymentId}:deployment`

/** `cms:<buildId>:build` — the build id is the producer's stable reference. */
export const buildEventId = (buildId: string): string => `cms:${buildId}:build`

/**
 * A correction names the accepted event and the replacement delta. The same
 * delta for the same event is the same id, so replaying the correction is safe.
 */
export const correctionEventId = (originalEventId: string, quantity: number): string =>
  `cms:correction:${originalEventId}:${quantity}`
