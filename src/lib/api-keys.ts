import { randomBytes, createHash } from 'crypto'

/**
 * Per-site and platform API keys (WAVE-9 §9.4) — the credential a headless builder
 * (`cafe-restaurant-pos`, or any other client of this CMS) authenticates with from a
 * non-customer origin, where `Host` cannot name the tenant.
 *
 * Framework-free, like `src/lib/slug.ts` and `src/lib/money.ts`: no `payload` import,
 * so both the collection hook and the access layer can use it without a cycle.
 */

/** `eshobe_live_` + 40 hex chars. The prefix lets a human eyeball "yes, that's a key" in a log line without it being one. */
const KEY_PREFIX = 'eshobe_live_'

/** How much of the raw key is safe to keep around for display — enough to tell two keys apart, not enough to guess the rest. */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8

export interface GeneratedApiKey {
  /** The full secret. Never stored — only returned once, at issue time. */
  raw: string
  /** sha256 hex of `raw`. This is what `api-keys.keyHash` stores and what a lookup hashes the incoming bearer token to compare against. */
  hash: string
  /** `raw`'s first characters, safe to store and list. */
  prefix: string
}

export const hashApiKey = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex')

export const generateApiKey = (): GeneratedApiKey => {
  const raw = `${KEY_PREFIX}${randomBytes(20).toString('hex')}`

  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, DISPLAY_PREFIX_LENGTH) }
}

/** `Authorization: Bearer <token>` → `<token>`, or `null` for anything else (missing header, a different scheme, empty). */
export const parseBearerToken = (header: null | string | undefined): null | string => {
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1]! : null
}
