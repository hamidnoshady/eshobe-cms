import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Secrets held by the control plane itself — webhook signing keys, plugin
 * credentials, outbound integration tokens.
 *
 * Same construction as `src/storage/crypto.ts`, `src/cdn/crypto.ts` and
 * `src/payments/gateways/crypto.ts`, and deliberately a *fourth* module rather than
 * a shared one: each has its own scrypt context, so rotating the object-storage key
 * cannot invalidate a webhook secret, and a key leaked from one domain does not
 * decrypt another's. The duplication is thirty lines; the coupling it avoids is the
 * kind that turns one incident into four.
 *
 * Format: `enc:v1:<base64url(iv ‖ tag ‖ ciphertext)>` — the version prefix is both
 * the upgrade path and how the encrypting hook tells stored ciphertext from a value
 * an admin just typed (it must not double-encrypt).
 *
 * **Rotating `PLATFORM_SECRET_KEY` or `PAYLOAD_SECRET` invalidates every stored
 * secret here.** There is no re-encryption job: a value that no longer decrypts
 * reads as "not configured", and the surface that needs it says so in Persian
 * rather than failing inside an HTTP call.
 */

const PREFIX = 'enc:v1:'
const CONTEXT = 'eshobe-cms:platform:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const isPlatformSecretEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

export class PlatformSecretKeyUnavailable extends Error {
  constructor() {
    super('PLATFORM_SECRET_KEY یا PAYLOAD_SECRET تنظیم نشده است؛ اعتبارنامهٔ سکو رمزنگاری نمی‌شود.')
    this.name = 'PlatformSecretKeyUnavailable'
  }
}

/** Read per call, never memoised at import: this module is pulled into the admin bundle and into `payload.config`. */
const key = (): Buffer => {
  const source = process.env.PLATFORM_SECRET_KEY?.trim() || process.env.PAYLOAD_SECRET
  if (!source) throw new PlatformSecretKeyUnavailable()
  const decoded = Buffer.from(source, 'base64url')
  return decoded.length === KEY_BYTES ? decoded : scryptSync(source, CONTEXT, KEY_BYTES)
}

export const encryptPlatformSecret = (value: string): string => {
  if (!value || isPlatformSecretEncrypted(value)) return value
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

/** `null` for empty, unencrypted, tampered or no-longer-decryptable values — all of which mean "not usable". */
export const decryptPlatformSecret = (value: null | string | undefined): null | string => {
  if (!value || !isPlatformSecretEncrypted(value)) return value || null
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url')
    if (raw.length < IV_BYTES + TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV_BYTES))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

/** A safe-to-show answer to "did that save?" — 48 bits, changes when the value changes. */
export const fingerprintPlatformSecret = (value: string): string =>
  createHmac('sha256', `${CONTEXT}:fingerprint`).update(value).digest('hex').slice(0, 12)

/** A fresh webhook signing secret: `whsec_` + 32 hex, the shape every consumer already knows from Stripe-style hooks. */
export const generateWebhookSecret = (): string => `whsec_${randomBytes(16).toString('hex')}`

/**
 * The signature a receiver verifies: `sha256=<hex>` over `<timestamp>.<body>`.
 *
 * The timestamp is inside the signed string, not merely a header beside it — that
 * is what makes a captured delivery un-replayable once the receiver enforces a
 * window, and a signature over the body alone is replayable forever.
 */
export const signWebhookPayload = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`

/** Constant-time compare, for a receiver implemented inside this codebase (tests, the self-test route). */
export const verifyWebhookSignature = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
