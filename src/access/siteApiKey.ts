import type { Access, CollectionBeforeChangeHook, PayloadRequest } from 'payload'

import { hashApiKey, parseBearerToken } from '@/lib/api-keys'
import { idOf } from '@/lib/ids'

/**
 * WAVE-9 §9.4 — API-key authentication, the counterpart to `src/access/siteRead.ts`'s
 * `Host`-based tenant resolution.
 *
 * `Host` answers "which site is this?" for a browser or a same-origin renderer. It
 * cannot answer it for a headless client calling from its own server (a POS, a
 * mobile backend) — there is no customer domain to send as `Host` from there. A
 * per-site API key is that client's tenant *and* its credential in one: unlike an
 * anonymous host-scoped read, holding a `role: "site"` key also unlocks drafts and
 * the write paths a site actually needs to operate its own store, because the key
 * itself proves the caller is that site's own integration, not a visitor.
 *
 * A `role: "platform"` key is the opposite shape on purpose: it proves "this caller
 * operates the platform" and is refused by every content access function below —
 * `platformApiKeyAware` is the one wrapper that accepts it, for the collections and
 * endpoints that are provisioning/lifecycle rather than content.
 */

export interface ResolvedApiKey {
  id: string
  role: 'platform' | 'site'
  siteId: null | string
}

const API_KEY_CONTEXT_KEY = 'eshobeRequestApiKey'

/** Best-effort telemetry — never on the hot path of the access decision it rides in on. */
const touchLastUsed = (req: PayloadRequest, id: string): void => {
  req.payload
    .update({ id, collection: 'api-keys', data: { lastUsedAt: new Date().toISOString() }, depth: 0, overrideAccess: true, req })
    .catch((error) => req.payload.logger.error(error))
}

/**
 * Bearer token → the key row it names, memoised on the request the same way
 * `requestSiteId` memoises the `Host` lookup (one hash lookup per request, however
 * many collections' access functions ask).
 *
 * `overrideAccess: true` on the lookup itself: this IS the authentication check —
 * `api-keys`'s own `read` access is `platformAdmin`, which would always deny it, the
 * same shape `src/lib/db.ts`'s `withoutTenantScope` documents on the sibling POS
 * codebase for "resolving a bearer credential to its tenant before one is chosen."
 */
export const requestApiKey = async (req: PayloadRequest): Promise<ResolvedApiKey | null> => {
  const cached = req.context[API_KEY_CONTEXT_KEY]
  if (cached !== undefined) return cached as ResolvedApiKey | null

  const token = parseBearerToken(req.headers?.get?.('authorization') ?? null)
  if (!token) {
    req.context[API_KEY_CONTEXT_KEY] = null
    return null
  }

  const { docs } = await req.payload.find({
    collection: 'api-keys',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { keyHash: { equals: hashApiKey(token) } },
  })

  const doc = docs[0]
  const resolved =
    doc && !doc.disabledAt
      ? { id: String(doc.id), role: doc.role, siteId: doc.role === 'site' ? idOf(doc.site) : null }
      : null

  req.context[API_KEY_CONTEXT_KEY] = resolved
  if (resolved) touchLastUsed(req, resolved.id)

  return resolved
}

/**
 * Read access for a public content collection (pages, posts, products, orders): a
 * valid site key sees its own site — drafts included, since holding the key *is* the
 * proof this is the site's own editor, not an anonymous visitor. A platform key
 * reads no content at all. No key present defers to `base` unchanged (the existing
 * `Host`-scoped/admin-session behaviour).
 */
export const apiKeyAware =
  (base: Access): Access =>
  async (args) => {
    const key = await requestApiKey(args.req)
    if (!key) return base(args)
    if (key.role !== 'site' || !key.siteId) return false
    return { site: { equals: key.siteId } }
  }

/**
 * Create access: there is no existing document to scope a `where` to, so a valid
 * site key simply may create — `forceApiKeySite` (below) is what stops it from
 * naming a different site in the payload. Mirrors `writeUnlessPublishing`'s own rule
 * for a non-owner: free to draft, never to publish over the API.
 */
export const apiKeyCreateAware =
  (base: Access): Access =>
  async (args) => {
    const key = await requestApiKey(args.req)
    if (!key) return base(args)
    if (key.role !== 'site' || !key.siteId) return false
    return (args.data as { _status?: string } | undefined)?._status !== 'published'
  }

/** Update access: the site-scoped `where`, plus the same never-publish-over-the-API rule as create. */
export const apiKeyUpdateAware =
  (base: Access): Access =>
  async (args) => {
    const key = await requestApiKey(args.req)
    if (!key) return base(args)
    if (key.role !== 'site' || !key.siteId) return false
    if ((args.data as { _status?: string } | undefined)?._status === 'published') return false
    return { site: { equals: key.siteId } }
  }

/**
 * For collections/endpoints that are platform administration rather than site
 * content (`sites`'s own read, `provision-site`): a platform key is accepted
 * alongside whatever `base` already allows (a platform-admin session). A site key
 * grants nothing here — it has no business listing every site on the platform.
 */
export const platformApiKeyAware =
  (base: Access): Access =>
  async (args) => {
    const key = await requestApiKey(args.req)
    if (key?.role === 'platform') return true
    return base(args)
  }

/** Whether this request is a platform-admin session or a valid platform key — the endpoint-level version of `platformApiKeyAware`, for handlers that are not a collection access function. */
export const isPlatformAdminOrPlatformKey = async (req: PayloadRequest, isPlatformAdmin: boolean): Promise<boolean> => {
  if (isPlatformAdmin) return true
  const key = await requestApiKey(req)
  return key?.role === 'platform'
}

/**
 * A create/update authorized by a site key must never be able to name a *different*
 * site in its payload — access only checked that a valid key exists, not which site
 * the client claims. This overwrites `data.site` with the key's own site whenever
 * one resolved, the same "the payload's tenant is never trusted, only the
 * credential's" rule Phase 34's MCP write path documents on the sibling POS
 * codebase. A no-op for an admin-session write (no key on the request).
 */
export const forceApiKeySite: CollectionBeforeChangeHook = async ({ data, req }) => {
  const key = await requestApiKey(req)
  if (key?.role !== 'site' || !key.siteId) return data
  return { ...data, site: key.siteId }
}
