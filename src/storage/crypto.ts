import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'

/**
 * The ArvanCloud object-storage secret key, encrypted at rest.
 *
 * Same construction as `src/cdn/crypto.ts` and `src/payments/gateways/crypto.ts`:
 * AES-256-GCM, key derived from `PAYLOAD_SECRET` with a fixed scrypt context, unless a
 * dedicated `OBJECT_STORAGE_KEY` is set. The dedicated key exists for the same reason as
 * the CDN and payment-gateway ones — rotating it re-encrypts the stored secret without
 * logging every editor out, whereas rotating `PAYLOAD_SECRET` (which also signs sessions,
 * order receipts and preview links) is a much bigger deal than re-entering one bucket key.
 *
 * **Rotating either invalidates the stored secret.** There is no re-encryption job here: a
 * platform admin re-enters it, and a connection whose secret no longer decrypts is refused
 * at upload time with a Persian message rather than failing inside the S3 call.
 *
 * Format: `enc:v1:<base64url(iv ‖ tag ‖ ciphertext)>`. The version prefix is what lets a
 * future algorithm change coexist with old rows, and it is how `isStorageSecretEncrypted`
 * tells a stored ciphertext from a plaintext the admin just typed (the encrypting hook must
 * not double-encrypt).
 */

const PREFIX = 'enc:v1:'
const CONTEXT = 'eshobe-cms:object-storage:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const isStorageSecretEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

export class StorageSecretKeyUnavailable extends Error {
  constructor() {
    super('OBJECT_STORAGE_KEY یا PAYLOAD_SECRET تنظیم نشده است؛ کلید ذخیره‌سازی رمزنگاری نمی‌شود.')
    this.name = 'StorageSecretKeyUnavailable'
  }
}

/** Read per call, not memoised at module load — the module is imported by the admin bundle
 * and by `payload.config`, where capturing `process.env` at import time would freeze a
 * secret that a test sets afterwards. */
const key = (): Buffer => {
  const source = process.env.OBJECT_STORAGE_KEY?.trim() || process.env.PAYLOAD_SECRET
  if (!source) throw new StorageSecretKeyUnavailable()
  const decoded = Buffer.from(source, 'base64url')
  return decoded.length === KEY_BYTES ? decoded : scryptSync(source, CONTEXT, KEY_BYTES)
}

export const encryptStorageSecret = (value: string): string => {
  if (!value || isStorageSecretEncrypted(value)) return value
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

/**
 * `enc:v1:…` → plaintext, or `null` when the value is empty, not encrypted, or no longer
 * decrypts (key rotation, a row copied between environments, a restored backup). A tampered
 * ciphertext is indistinguishable from those cases because GCM's tag check fails, and all of
 * them must read as "this connection is not usable" rather than a 500 on a customer upload.
 */
export const decryptStorageSecret = (value: null | string | undefined): null | string => {
  if (!value || !isStorageSecretEncrypted(value)) return value || null
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
export const fingerprintStorageSecret = (value: string): string =>
  createHmac('sha256', `${CONTEXT}:fingerprint`).update(value).digest('hex').slice(0, 12)
