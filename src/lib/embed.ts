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

/**
 * Collections the embed may open. Anything else is a 400, never a pass-through.
 *
 * Every entry is a tenant collection in the multi-tenant plugin's map, so the service
 * user's one tenant scopes it; `header`, `footer` and `site-branding` are per-site
 * singletons (`isGlobal`), which the plugin redirects from the list view to the site's
 * own document.
 */
export const EMBED_COLLECTIONS = [
  'posts',
  'pages',
  'categories',
  'media',
  'forms',
  'form-submissions',
  'header',
  'footer',
  'site-branding',
] as const
export type EmbedCollection = (typeof EMBED_COLLECTIONS)[number]

export const isEmbedCollection = (value: unknown): value is EmbedCollection =>
  typeof value === 'string' && (EMBED_COLLECTIONS as readonly string[]).includes(value)

/**
 * What the frame lands on: one document (`edit`, or its create form without an id), a
 * collection's list, or the site's whole admin (`dashboard`). Only `dashboard` keeps the
 * admin's own sidebar — it *is* the site's management panel, shown inside the POS.
 */
export const EMBED_VIEWS = ['edit', 'list', 'dashboard'] as const
export type EmbedView = (typeof EMBED_VIEWS)[number]

export const isEmbedView = (value: unknown): value is EmbedView =>
  typeof value === 'string' && (EMBED_VIEWS as readonly string[]).includes(value)

/** Marker cookie values: `1` drops the sidebar and header, `full` keeps the admin's own chrome. */
export type EmbedChromeMode = '1' | 'full'

export const embedChromeFor = (view: EmbedView): EmbedChromeMode => (view === 'dashboard' ? 'full' : '1')

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
export const embedTargetPath = (
  collection: EmbedCollection | null,
  id?: string,
  view: EmbedView = 'edit',
): string => {
  if (view === 'dashboard' || !collection) return '/admin'
  if (view === 'list') return `/admin/collections/${collection}`
  return `/admin/collections/${collection}/${id ?? 'create'}`
}

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
