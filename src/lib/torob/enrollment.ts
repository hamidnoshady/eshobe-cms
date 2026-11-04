/**
 * The CMS's local projection of Biza Miz's Torob enrollment.
 *
 * Growth owns the merchant lifecycle; this row is the runtime gate the crawler reads
 * without calling Growth. A missing projection is disconnected/unauthorized/disabled.
 * Only the platform control surface writes it (the fields are hidden and locked in the
 * CMS admin), so there is no second Torob dashboard here.
 */
import { siteOrigin } from '@/lib/site-url'
import { TOROB_PRODUCTS_PATH } from '@/lib/slug'

export { TOROB_PRODUCTS_PATH }

/** The canonical endpoint Biza Miz registers with Torob for a managed CMS site. */
export const torobEndpointForSite = (site: { domain: string }): string =>
  `${siteOrigin({ defaultLocale: 'fa', domain: site.domain })}${TOROB_PRODUCTS_PATH}`

export const TOROB_AUTHORIZATION_STATES = [
  'not_authorized',
  'pending_approval',
  'authorized',
  'revoked',
] as const
export type TorobAuthorizationState = (typeof TOROB_AUTHORIZATION_STATES)[number]

export type TorobEnrollment = {
  authorizationState: TorobAuthorizationState
  connected: boolean
  enabled: boolean
  /** Opaque Biza Miz shop id, for coordination only; never a tenant selector here. */
  shopId?: null | string
  syncedAt?: null | string
}

export const DEFAULT_TOROB_ENROLLMENT: TorobEnrollment = {
  authorizationState: 'not_authorized',
  connected: false,
  enabled: false,
  shopId: null,
  syncedAt: null,
}

export type TorobEnrollmentParse =
  | { ok: false; message: string }
  | { ok: true; value: TorobEnrollment }

/** Full-state sync: a partial patch cannot accidentally leave an old `enabled: true`. */
export const parseTorobEnrollment = (body: unknown): TorobEnrollmentParse => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'بدنهٔ درخواست باید یک شیء JSON باشد.' }
  }
  const input = body as Record<string, unknown>
  const allowed = new Set(['authorizationState', 'connected', 'enabled', 'shopId'])
  const unknown = Object.keys(input).filter((key) => !allowed.has(key))
  if (unknown.length) return { ok: false, message: `کلید ناشناخته: ${unknown.join(', ')}` }
  if (typeof input.connected !== 'boolean' || typeof input.enabled !== 'boolean') {
    return { ok: false, message: 'connected و enabled باید بولی باشند.' }
  }
  if (
    typeof input.authorizationState !== 'string' ||
    !(TOROB_AUTHORIZATION_STATES as readonly string[]).includes(input.authorizationState)
  ) {
    return { ok: false, message: 'authorizationState معتبر نیست.' }
  }
  if (
    input.shopId !== undefined &&
    input.shopId !== null &&
    (typeof input.shopId !== 'string' || input.shopId.trim().length > 200)
  ) {
    return { ok: false, message: 'shopId باید رشته‌ای حداکثر ۲۰۰ نویسه باشد.' }
  }
  return {
    ok: true,
    value: {
      authorizationState: input.authorizationState as TorobAuthorizationState,
      connected: input.connected,
      enabled: input.enabled,
      shopId: typeof input.shopId === 'string' ? input.shopId.trim() || null : null,
    },
  }
}

export const torobEnrollmentOf = (site: unknown): TorobEnrollment => {
  const raw = (site as { torob?: Partial<TorobEnrollment> | null } | null)?.torob
  if (!raw) return DEFAULT_TOROB_ENROLLMENT
  return {
    authorizationState:
      typeof raw.authorizationState === 'string' &&
      (TOROB_AUTHORIZATION_STATES as readonly string[]).includes(raw.authorizationState)
        ? raw.authorizationState
        : 'not_authorized',
    connected: raw.connected === true,
    enabled: raw.enabled === true,
    shopId: typeof raw.shopId === 'string' ? raw.shopId : null,
    syncedAt: typeof raw.syncedAt === 'string' ? raw.syncedAt : null,
  }
}

/** The one runtime predicate. Every false is a plain 404 to the crawler. */
export const torobEnrollmentServes = (site: unknown): boolean => {
  const row = site as { status?: unknown; type?: unknown } | null
  const enrollment = torobEnrollmentOf(site)
  return (
    row?.status === 'active' &&
    row.type === 'store' &&
    enrollment.connected &&
    enrollment.enabled &&
    enrollment.authorizationState === 'authorized'
  )
}
