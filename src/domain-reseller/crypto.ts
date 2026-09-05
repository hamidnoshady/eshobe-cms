import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'
const CONTEXT = 'eshobe-cms:domain-reseller:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const isDomainResellerSecretEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

export class DomainResellerSecretKeyUnavailable extends Error {
  constructor() {
    super(
      'DOMAIN_RESELLER_KEY یا PAYLOAD_SECRET تنظیم نشده است؛ اعتبارنامهٔ نمایندگی دامنه رمزنگاری نمی‌شود.',
    )
    this.name = 'DomainResellerSecretKeyUnavailable'
  }
}

/** Read at every call so tests and a restarted deployment can rotate the dedicated key. */
const key = (): Buffer => {
  const dedicated = process.env.DOMAIN_RESELLER_KEY?.trim()
  const source = dedicated && dedicated.length >= 32 ? dedicated : process.env.PAYLOAD_SECRET

  if (!source) throw new DomainResellerSecretKeyUnavailable()

  const decoded = Buffer.from(source, 'base64url')
  return decoded.length === KEY_BYTES ? decoded : scryptSync(source, CONTEXT, KEY_BYTES)
}

export const encryptDomainResellerSecret = (value: string): string => {
  if (!value || isDomainResellerSecretEncrypted(value)) return value

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

/** `null` is deliberately non-throwing: a stale or tampered secret must stop an order,
 * not leak a cryptographic distinction to a tenant. */
export const decryptDomainResellerSecret = (value: null | string | undefined): null | string => {
  if (!value || !isDomainResellerSecretEncrypted(value)) return value || null

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

export const fingerprintDomainResellerSecret = (value: string): string =>
  createHmac('sha256', `${CONTEXT}:fingerprint`).update(value).digest('hex').slice(0, 12)
