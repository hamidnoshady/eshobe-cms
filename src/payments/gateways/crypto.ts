import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Secrets at rest, and the signatures that make a callback trustworthy.
 *
 * ## Why encrypt at all
 *
 * A merchant's `client_secret` is not this platform's credential — it is a *customer's*,
 * and it moves money out of that customer's account. Postgres credentials in a `text`
 * column means anyone with a read-only dump, a stolen backup, or a SQL injection
 * somewhere else in the stack holds every tenant's PSP access at once. So the value that
 * reaches the database is ciphertext, and the plaintext exists only inside one adapter
 * call.
 *
 * The fields are *also* unreadable through every API (`src/collections/PaymentGateways.ts`
 * sets `access.read: () => false` on them), which is the other half: encryption protects
 * against a database leak, field access protects against an API one. Neither alone is
 * enough — ciphertext that any authenticated editor can read is a plaintext with extra
 * steps.
 *
 * ## Key
 *
 * Derived from `PAYLOAD_SECRET` by scrypt with a fixed context string, unless
 * `PAYMENT_GATEWAYS_KEY` is set. A dedicated key is worth having for one reason: rotating
 * it re-encrypts credentials without logging every editor out, and rotating
 * `PAYLOAD_SECRET` (which also signs sessions, order receipts and preview links) is a
 * much bigger deal than re-entering four merchant accounts.
 *
 * **Rotating either invalidates every stored credential.** There is no re-encryption job
 * here — a platform admin re-enters them, and a row whose secrets no longer decrypt is
 * refused by `resolve.ts` with a Persian message rather than failing at the PSP.
 *
 * ## Format
 *
 * `enc:v1:<base64url(iv ‖ tag ‖ ciphertext)>`. The version prefix is what makes a future
 * algorithm change possible without guessing which rows are which, and it is also how
 * `isEncrypted()` tells a stored ciphertext from a plaintext an admin just typed — the
 * hook that encrypts runs on both create and update, and must not double-encrypt.
 */

const PREFIX = 'enc:v1:'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SCRYPT_CONTEXT = 'eshobe-cms:payment-gateways:v1'

/** The whole envelope is one string, so a `text` column is enough and no schema change is needed to rotate. */
export const isEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

export class SecretKeyUnavailable extends Error {
  constructor() {
    super('PAYMENT_GATEWAYS_KEY یا PAYLOAD_SECRET تنظیم نشده است؛ اعتبارنامهٔ درگاه رمزنگاری نمی‌شود.')
    this.name = 'SecretKeyUnavailable'
  }
}

/**
 * Read per call, not memoised at module load. The module is imported by the admin bundle
 * and by `payload.config`, where capturing `process.env` at import time would freeze a
 * secret that a test sets afterwards — the same rule `CLAUDE.md` states for the
 * checkout's env-tunable limits.
 */
const deriveKey = (): Buffer => {
  const dedicated = process.env.PAYMENT_GATEWAYS_KEY

  if (dedicated && dedicated.trim().length >= 32) {
    return Buffer.from(dedicated.trim(), 'base64url').length === KEY_BYTES
      ? Buffer.from(dedicated.trim(), 'base64url')
      : scryptSync(dedicated.trim(), SCRYPT_CONTEXT, KEY_BYTES)
  }

  const secret = process.env.PAYLOAD_SECRET

  if (!secret) throw new SecretKeyUnavailable()

  return scryptSync(secret, SCRYPT_CONTEXT, KEY_BYTES)
}

/** `plaintext` → `enc:v1:…`. An already-encrypted value passes through untouched. */
export const encryptSecret = (value: string): string => {
  if (!value || isEncrypted(value)) return value

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

/**
 * `enc:v1:…` → plaintext.
 *
 * `null` rather than a throw: a key rotation, a row copied between environments, or a
 * database restored from before the secret existed all produce undecryptable values, and
 * every one of them should read as "this gateway is not configured" at the storefront
 * instead of a 500 on a buyer's checkout. GCM's tag check is what makes a tampered
 * ciphertext indistinguishable from those cases — it fails, and the answer is `null`.
 */
export const decryptSecret = (value: null | string | undefined): null | string => {
  if (!value || !isEncrypted(value)) return value || null

  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url')

    if (raw.length < IV_BYTES + TAG_BYTES) return null

    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)

    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv)
    decipher.setAuthTag(tag)

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * One value's fingerprint, safe to store and show: `sha256` truncated to 12 hex chars.
 *
 * The admin cannot read a secret back (it is write-only by design), so it needs *some*
 * answer to "did that save?" — and the wrong answers are either "yes" with nothing there
 * or a value that leaks. A fingerprint is neither: it changes when the value changes, and
 * at 48 bits over a value nobody can enumerate it is not a guess.
 */
export const fingerprintSecret = (value: string): string =>
  createHmac('sha256', `${SCRYPT_CONTEXT}:fingerprint`).update(value, 'utf8').digest('hex').slice(0, 12)

/**
 * A signature over the facts a callback is allowed to depend on.
 *
 * The checkout callback URL carries `order=<uuid>`, and the site comes from `Host`. That
 * is already enough to stop a forged *payment* — `confirm()` asks the PSP — but not
 * enough to stop a forged *routing*: someone who has watched one callback can replay the
 * URL against a different order id they own, or hand a gateway a `gw=` that does not
 * match the order's stored provider and make the platform run the wrong adapter against
 * the right PSP. Binding `{ site, order, gateway, amount }` under one HMAC makes any of
 * those a verification failure instead of a confused success.
 *
 * Same construction as `src/lib/order-receipt.ts`: HMAC-SHA256 over a versioned context
 * string, truncated to 128 bits of base64url, compared with `timingSafeEqual`.
 *
 * ## Expiry
 *
 * Unlike an order receipt, a callback signature does expire. A receipt is a document the
 * buyer keeps; a callback URL is a thing that lands in a PSP's request log, a proxy's
 * access log and a browser's history, and stays drivable forever unless it carries a
 * deadline. Replaying one cannot double-charge anything — `confirm` is idempotent and asks
 * the PSP — but an indefinitely valid URL is one more thing to reason about, and the fix
 * costs eight characters.
 *
 * The token is therefore `<issuedAt>.<hmac>`, with `issuedAt` (seconds since the epoch,
 * base36) *inside* the signed payload. Signing over the timestamp is what makes it
 * unforgeable: an attacker who shortens or lengthens it invalidates the signature, so the
 * only tokens that verify are ones this server issued, at the moment it issued them.
 *
 * The window is `PAYMENT_GATEWAY_STATE_TTL_MS`, read per call like every other limit in
 * this codebase. The default is generous on purpose — an instalment flow can send a buyer
 * through identity verification and a four-step approval before it redirects back, and a
 * signature that expires mid-flow turns a completed payment into a support ticket. Being
 * generous is cheap here precisely because a replay cannot move money.
 */

const STATE_LENGTH = 22

/** 30 minutes. Long enough for a BNPL approval flow, short enough to not be forever. */
const DEFAULT_STATE_TTL_MS = 30 * 60_000

const stateTtlMs = (): number => {
  const configured = Number(process.env.PAYMENT_GATEWAY_STATE_TTL_MS ?? DEFAULT_STATE_TTL_MS)

  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STATE_TTL_MS
}

const stateSecret = (): string => {
  const value = process.env.PAYMENT_GATEWAYS_KEY ?? process.env.PAYLOAD_SECRET

  if (!value) throw new SecretKeyUnavailable()

  return value
}

export type GatewayStateClaims = {
  amount: number
  gateway: string
  orderId: string
  siteId: string
}

/** The signed part. `issuedAt` is inside it, so the deadline cannot be moved. */
const signState = (claims: GatewayStateClaims, issuedAt: number): string =>
  createHmac('sha256', stateSecret())
    .update(
      `eshobe-payment-state:v1:${claims.siteId}:${claims.orderId}:${claims.gateway}:${claims.amount}:${issuedAt}`,
    )
    .digest('base64url')
    .slice(0, STATE_LENGTH)

export const signGatewayState = (claims: GatewayStateClaims): string => {
  const issuedAt = Math.floor(Date.now() / 1000)

  return `${issuedAt.toString(36)}.${signState(claims, issuedAt)}`
}

/**
 * Constant-time, and `false` for anything malformed or too old rather than a throw: this
 * runs on a request whose entire content an attacker controls.
 */
export const verifyGatewayState = (token: unknown, claims: GatewayStateClaims): boolean => {
  if (typeof token !== 'string' || !token) return false

  const separator = token.indexOf('.')

  if (separator <= 0 || separator === token.length - 1) return false

  const issuedAt = Number.parseInt(token.slice(0, separator), 36)

  // A timestamp in the future, or one that is not a number at all, is a forged or
  // corrupted token. Checked before the HMAC so a nonsense prefix cannot be compared.
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false

  const ageMs = Date.now() - issuedAt * 1000

  if (ageMs < 0 || ageMs > stateTtlMs()) return false

  const expected = Buffer.from(signState(claims, issuedAt), 'utf8')
  // Bounded before it is compared, so a megabyte of `A` cannot be handed to
  // `timingSafeEqual` as a way of measuring how far the comparison got.
  const given = Buffer.from(token.slice(separator + 1, separator + 1 + 64), 'utf8')

  // `timingSafeEqual` throws on a length mismatch, and the length of a truncated HMAC is
  // not a secret — a plain `===` here would be, because it short-circuits on the first
  // differing byte and the difference is measurable.
  return expected.length === given.length && timingSafeEqual(expected, given)
}
