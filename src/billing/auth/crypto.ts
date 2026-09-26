/**
 * Ciphertext for the billing service credential.
 *
 * A separate scrypt context from platform webhooks, object storage and payment
 * gateways: rotating one of those keys must not invalidate the billing secret,
 * and a leak of one context must not decrypt this one.
 *
 * Format matches the others (`enc:v1:`) so operators can recognise ciphertext,
 * but the bytes are not interchangeable.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = 'enc:v1:'
const CONTEXT = 'eshobe-cms:billing-service:v1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const isBillingSecretEncrypted = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX)

const key = (): Buffer => {
  const source = process.env.BILLING_SERVICE_KEY?.trim() || process.env.PAYLOAD_SECRET
  if (!source) throw new Error('PAYLOAD_SECRET is required to seal billing credentials.')
  const decoded = Buffer.from(source, 'base64url')
  return decoded.length === KEY_BYTES ? decoded : scryptSync(source, CONTEXT, KEY_BYTES)
}

export const encryptBillingSecret = (value: string): string => {
  if (!value || isBillingSecretEncrypted(value)) return value
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
}

export const decryptBillingSecret = (value: null | string | undefined): null | string => {
  if (!value || !isBillingSecretEncrypted(value)) return null
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url')
    if (raw.length < IV_BYTES + TAG_BYTES) return null
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, IV_BYTES))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
