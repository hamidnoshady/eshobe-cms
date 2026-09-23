import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'

/**
 * Secrets belonging to the *deployment* surface: a Coolify API token, a theme's
 * per-deployment revalidation secret, and the tenant-supplied build variables a
 * theme manifest declares `secret: true`.
 *
 * A fifth crypto module, alongside `src/lib/saas/crypto.ts`, `src/storage/crypto.ts`,
 * `src/cdn/crypto.ts` and `src/payments/gateways/crypto.ts`, and for the same reason
 * each of those is its own: a distinct scrypt context means a key leaked from one
 * domain decrypts nothing in another. This one is the most valuable of the five —
 * a Coolify token can start and stop every customer's storefront — so it is the
 * last one that should share a key with anything.
 *
 * Format: `enc:v1:<base64url(iv ‖ tag ‖ ciphertext)>`. The prefix is how an
 * encrypting hook tells stored ciphertext from a value an admin just typed, so it
 * cannot double-encrypt.
 *
 * **Rotating `DEPLOY_SECRET_KEY` or `PAYLOAD_SECRET` invalidates every stored token
 * here.** There is no re-encryption job: a value that no longer decrypts reads as
 * "not configured", the target's self-test says so in Persian, and no deploy is
 * attempted with a half-known credential.
 */

const PREFIX = 'enc:v1:'
const CONTEXT = 'eshobe-cms:deployments:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const isDeploySecretEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

export class DeploySecretKeyUnavailable extends Error {
  constructor() {
    super('DEPLOY_SECRET_KEY یا PAYLOAD_SECRET تنظیم نشده است؛ توکن استقرار رمزنگاری نمی‌شود.')
    this.name = 'DeploySecretKeyUnavailable'
  }
}

/** Read per call, never memoised at import: this module is reachable from `payload.config`. */
const key = (): Buffer => {
  const source = process.env.DEPLOY_SECRET_KEY?.trim() || process.env.PAYLOAD_SECRET
  if (!source) throw new DeploySecretKeyUnavailable()
  const decoded = Buffer.from(source, 'base64url')
  return decoded.length === KEY_BYTES ? decoded : scryptSync(source, CONTEXT, KEY_BYTES)
}

export const encryptDeploySecret = (value: string): string => {
  if (!value || isDeploySecretEncrypted(value)) return value
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

/** `null` for empty, unencrypted, tampered or no-longer-decryptable values — all of which mean "not usable". */
export const decryptDeploySecret = (value: null | string | undefined): null | string => {
  if (!value || !isDeploySecretEncrypted(value)) return value || null
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

/** A safe-to-show answer to "did that token save?" — 48 bits, changes when the value changes. */
export const fingerprintDeploySecret = (value: string): string =>
  createHmac('sha256', `${CONTEXT}:fingerprint`).update(value).digest('hex').slice(0, 12)

/**
 * The secret a deployed theme verifies `POST /api/revalidate` with.
 *
 * Per deployment, never global: one shared secret across twenty storefronts means
 * any theme author who reads their own env can forge a cache purge at every other
 * customer on the fleet.
 */
export const generateRevalidateSecret = (): string => `esrv_${randomBytes(24).toString('hex')}`
