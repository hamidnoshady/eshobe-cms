/**
 * Deprecated platform ingest auth (pre billing-contract/v1).
 *
 * HMAC-SHA256(secret, "<unix-ms>\\n<nonce>\\n<sha256-hex(raw body)>") as lowercase hex,
 * with a per-key nonce table on the receiver. CMS inbound routes use
 * billing-contract/v1 only; this module exists for cutover tests and any
 * temporary outbound adapter while central Billing still expects the old headers.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const LEGACY_KEY_HEADER = 'x-billing-key-id'
export const LEGACY_TIMESTAMP_HEADER = 'x-billing-timestamp'
export const LEGACY_NONCE_HEADER = 'x-billing-nonce'
export const LEGACY_SIGNATURE_HEADER = 'x-billing-signature'

export const LEGACY_REPLAY_WINDOW_MS = 5 * 60 * 1000

export type LegacySignatureVerdict =
  | { ok: true; nonce: string; timestampMs: string }
  | { ok: false; reason: 'expired' | 'malformed' | 'mismatch' }

export const signLegacyUsageBody = (args: {
  body: string
  nonce: string
  secret: string
  timestampMs: string
}): string => {
  const bodyHash = createHash('sha256').update(args.body).digest('hex')
  return createHmac('sha256', args.secret)
    .update(`${args.timestampMs}\n${args.nonce}\n${bodyHash}`)
    .digest('hex')
}

export const verifyLegacyUsageSignature = (args: {
  body: string
  nonce: null | string
  now?: number
  secret: string
  signature: null | string
  timestampMs: null | string
}): LegacySignatureVerdict => {
  const timestampMs = args.timestampMs?.trim() ?? ''
  const nonce = args.nonce?.trim() ?? ''
  if (!/^\d{10,13}$/.test(timestampMs) || !nonce || nonce.length > 200 || !args.signature) {
    return { ok: false, reason: 'malformed' }
  }
  const ts = Number(timestampMs)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed' }
  const skew = Math.abs((args.now ?? Date.now()) - ts)
  if (skew > LEGACY_REPLAY_WINDOW_MS) return { ok: false, reason: 'expired' }
  const expected = signLegacyUsageBody({ body: args.body, nonce, secret: args.secret, timestampMs })
  const a = Buffer.from(expected)
  const b = Buffer.from(args.signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' }
  return { ok: true, nonce, timestampMs }
}

export const mintLegacyNonce = (): string => randomBytes(12).toString('hex')
