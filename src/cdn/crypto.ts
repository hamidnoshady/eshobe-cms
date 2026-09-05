import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'
const CONTEXT = 'eshobe-cms:cdn-integrations:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const isCdnSecretEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

export class CdnSecretKeyUnavailable extends Error {
  constructor() {
    super(
      'CDN_INTEGRATIONS_KEY یا PAYLOAD_SECRET تنظیم نشده است؛ اعتبارنامهٔ CDN رمزنگاری نمی‌شود.',
    )
    this.name = 'CdnSecretKeyUnavailable'
  }
}

const key = (): Buffer => {
  const source = process.env.CDN_INTEGRATIONS_KEY?.trim() || process.env.PAYLOAD_SECRET
  if (!source) throw new CdnSecretKeyUnavailable()
  const decoded = Buffer.from(source, 'base64url')
  return decoded.length === KEY_BYTES ? decoded : scryptSync(source, CONTEXT, KEY_BYTES)
}

export const encryptCdnSecret = (value: string): string => {
  if (!value || isCdnSecretEncrypted(value)) return value
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

export const decryptCdnSecret = (value: null | string | undefined): null | string => {
  if (!value || !isCdnSecretEncrypted(value)) return value || null
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

export const fingerprintCdnSecret = (value: string): string =>
  createHmac('sha256', `${CONTEXT}:fingerprint`).update(value).digest('hex').slice(0, 12)
