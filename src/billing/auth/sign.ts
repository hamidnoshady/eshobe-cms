/**
 * Service-to-service authentication for the billing boundary.
 *
 * The signature covers `<unix-seconds>.<raw body>`, the same construction as
 * platform webhooks (`signWebhookPayload`). A body-only signature would replay
 * forever. The secret itself is never assembled into a log line here.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { signWebhookPayload, verifyWebhookSignature } from '@/lib/saas/crypto'

export const BILLING_SIGNATURE_HEADER = 'x-eshobe-billing-signature'
export const BILLING_TIMESTAMP_HEADER = 'x-eshobe-billing-timestamp'
export const BILLING_KEY_HEADER = 'x-eshobe-billing-key'

/** Five minutes. A clock skew larger than this is a replay, not a slow client. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000

export const BILLING_SCOPES = ['billing.usage.write', 'billing.entitlement.write'] as const
export type BillingScope = (typeof BILLING_SCOPES)[number]

export const isBillingScope = (value: unknown): value is BillingScope =>
  value === 'billing.usage.write' || value === 'billing.entitlement.write'

export const signBillingBody = (secret: string, timestampSec: string, body: string): string =>
  signWebhookPayload(secret, timestampSec, body)

export const bodyFingerprint = (timestampSec: string, body: string): string =>
  createHash('sha256').update(`${timestampSec}.${body}`).digest('hex')

export type SignatureVerdict =
  | { ok: true; timestampSec: string }
  | { ok: false; reason: 'expired' | 'malformed' | 'mismatch' }

export const verifyBillingSignature = (args: {
  body: string
  now?: number
  secret: string
  signature: null | string
  timestamp: null | string
}): SignatureVerdict => {
  const timestamp = args.timestamp?.trim() ?? ''
  if (!/^\d{10}$/.test(timestamp) || !args.signature) return { ok: false, reason: 'malformed' }
  const skew = Math.abs((args.now ?? Date.now()) - Number(timestamp) * 1000)
  if (skew > REPLAY_WINDOW_MS) return { ok: false, reason: 'expired' }
  const expected = signBillingBody(args.secret, timestamp, args.body)
  if (!verifyWebhookSignature(expected, args.signature)) return { ok: false, reason: 'mismatch' }
  return { ok: true, timestampSec: timestamp }
}

/** Constant-time equality for two hex digests of equal length. */
export const digestEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
