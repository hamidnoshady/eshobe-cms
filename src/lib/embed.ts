import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * The embed session: how the sibling POS shows one CMS admin document inside its own
 * modal without making the person sign in a second time.
 *
 * Pure parts only — hashing, the redirect allowlist, cookie wording. The endpoints
 * (`src/endpoints/platformEmbed.ts`) do the I/O.
 */

/** A one-time code lives this long. It is spent by the iframe's first request. */
export const EMBED_CODE_TTL_MS = 60_000

/** Marker cookie the admin chrome reads (server-side) to drop the sidebar and header. */
export const EMBED_MARKER_COOKIE = 'eshobe-embed'

/** Collections the embed may open. Anything else is a 400, never a pass-through. */
export const EMBED_COLLECTIONS = ['posts', 'pages'] as const
export type EmbedCollection = (typeof EMBED_COLLECTIONS)[number]

export const isEmbedCollection = (value: unknown): value is EmbedCollection =>
  typeof value === 'string' && (EMBED_COLLECTIONS as readonly string[]).includes(value)

export type EmbedAccess = 'editor' | 'owner'

export const newEmbedCode = (): string => randomBytes(32).toString('base64url')

/** Only the hash is stored: a leaked KV row is not a usable code. */
export const embedCodeKey = (code: string): string =>
  `embed:${createHash('sha256').update(code).digest('hex')}`

export const embedUserEmail = (siteId: string, access: EmbedAccess): string =>
  `embed-${access}+${siteId}@embed.invalid`

/**
 * The service user's password is derived, not stored and not rotated: nobody holds it
 * (it is an HMAC under the server secret), two concurrent embeds can never overwrite
 * each other's, and a changed secret is healed by resetting it once.
 */
export const embedUserPassword = (secret: string, email: string): string =>
  createHmac('sha256', secret).update(`embed-user:${email}`).digest('base64url')

/**
 * The only place the landing path is built, from a validated collection and a uuid —
 * never from request input, so the code cannot be turned into an open redirect.
 */
export const embedTargetPath = (collection: EmbedCollection, id?: string): string =>
  `/admin/collections/${collection}/${id ?? 'create'}`

export type EmbedCookieSpec = { httpOnly: boolean; maxAge: number; name: string; value: string }

/**
 * `SameSite=None; Partitioned` so the frame keeps its cookie when the POS is a
 * different site (Chromium, Firefox); `Lax` when the connection is plain http (dev),
 * where `Secure` cookies would be dropped.
 */
export const serializeEmbedCookie = (spec: EmbedCookieSpec, secure: boolean): string => {
  const parts = [
    `${spec.name}=${encodeURIComponent(spec.value)}`,
    'Path=/',
    `Max-Age=${Math.max(1, Math.floor(spec.maxAge))}`,
  ]
  if (spec.httpOnly) parts.push('HttpOnly')
  if (secure) parts.push('Secure', 'SameSite=None', 'Partitioned')
  else parts.push('SameSite=Lax')
  return parts.join('; ')
}
