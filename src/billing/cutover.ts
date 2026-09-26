/**
 * Read-path cutover. Writes to plans, subscriptions and invoices are frozen
 * regardless of this value — the phase only chooses which cached decision
 * `resolveEntitlement` serves.
 *
 *   legacy  — the old local merge, for comparison during migration.
 *   dual    — serve the old merge, and record where it disagrees with the projection.
 *   central — a projection, when one exists, is the commercial answer.
 *             A site with no projection yet keeps the legacy read so a missing
 *             sync does not take the site down. That fallback is read-only.
 *
 * Default is `central`.
 */

export type BillingCutoverPhase = 'central' | 'dual' | 'legacy'

export const billingCutoverPhase = (raw = process.env.BILLING_CUTOVER): BillingCutoverPhase => {
  if (raw === 'legacy' || raw === 'dual' || raw === 'central') return raw
  return 'central'
}
