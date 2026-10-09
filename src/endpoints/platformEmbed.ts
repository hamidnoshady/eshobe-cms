import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { docBelongsToSite } from '@/endpoints/platformOwnerBridge'
import {
  EMBED_CODE_TTL_MS,
  EMBED_MARKER_COOKIE,
  embedCodeKey,
  embedTargetPath,
  embedUserEmail,
  embedUserPassword,
  isEmbedCollection,
  newEmbedCode,
  serializeEmbedCookie,
  type EmbedAccess,
  type EmbedCollection,
} from '@/lib/embed'
import { idOf, isUuid } from '@/lib/ids'
import { getServerSideURL } from '@/utilities/getURL'

import { json, param, readJsonBody, requireOperator, siteById } from './platformShared'

/** What the one-time code stands for. Stored under the hash of the code, never under it. */
type EmbedGrant = { email: string; expiresAt: number; siteId: string; target: string }

const KV_PREFIX = 'embed:'

const TENANT_COOKIE = 'payload-tenant'

/**
 * The service user an embed session acts as: one per site per access level.
 *
 * Reusing the tenant role model is the point — `writeUnlessPublishing` already hides
 * Publish from an `editor` and refuses it over REST, so the POS's `cms.publish`
 * decision becomes "which of the two users" and nothing new has to be trusted.
 *
 * The row is healed on every call (tenant list, role) because a site owner can edit or
 * delete users on their own site, and an embed that stops working until an operator
 * notices is worse than a user that quietly comes back.
 */
const ensureEmbedUser = async (payload: Payload, siteId: string, access: EmbedAccess): Promise<string> => {
  const email = embedUserEmail(siteId, access)
  const password = embedUserPassword(payload.secret, email)
  const tenants = [{ role: access, tenant: siteId }]

  const find = async () =>
    (
      await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        pagination: false,
        where: { email: { equals: email } },
      })
    ).docs[0]

  let user = await find()

  if (!user) {
    try {
      user = await payload.create({
        collection: 'users',
        data: {
          email,
          name: access === 'owner' ? 'سایت‌ساز (مدیر)' : 'سایت‌ساز (ویرایشگر)',
          password,
          role: 'user',
          tenants,
        },
        depth: 0,
        overrideAccess: true,
      })
    } catch (error) {
      // Two embeds opened at once: the loser of the unique-email race reads the winner's row.
      user = await find()
      if (!user) throw error
    }
  } else {
    const rows = user.tenants ?? []
    const exact = rows.length === 1 && idOf(rows[0]?.tenant) === siteId && rows[0]?.role === access
    if (!exact || user.role !== 'user') {
      user = await payload.update({
        collection: 'users',
        data: { role: 'user', tenants },
        depth: 0,
        id: user.id,
        overrideAccess: true,
      })
    }
  }

  // `Users.beforeChange` promotes the first account in a database with no platform admin
  // (dev/test). This user must never be that account.
  if (user.role !== 'user') {
    await payload.delete({ collection: 'users', id: user.id, overrideAccess: true })
    throw new Error('embed service user was created with an elevated role')
  }

  return email
}

const pruneExpired = async (payload: Payload): Promise<void> => {
  const now = Date.now()
  for (const key of await payload.kv.keys()) {
    if (!key.startsWith(KV_PREFIX)) continue
    const grant = await payload.kv.get<EmbedGrant>(key)
    if (!grant || grant.expiresAt <= now) await payload.kv.delete(key)
  }
}

/**
 * `POST /api/platform/sites/:id/embed-session` — platform key mints a one-time entry
 * URL that opens one admin document for one site.
 *
 * `canPublish` is the caller's claim about its own user and is trusted exactly as far
 * as the platform key is: that key can already publish any document through
 * `/platform/sites/:id/publish`.
 */
export const platformSiteEmbedSessionEndpoint: Endpoint = {
  path: '/platform/sites/:id/embed-session',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const siteId = param(req, 'id')
    if (!isUuid(siteId)) return json({ message: 'شناسهٔ سایت نامعتبر است.', ok: false }, 400)
    if (!(await siteById(req, siteId))) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readJsonBody(req)
    if (error) return error

    const collection = body?.collection
    if (!isEmbedCollection(collection)) {
      return json({ message: 'مجموعهٔ ویرایش نامعتبر است.', ok: false }, 400)
    }

    const rawId = body?.id
    let docId: string | undefined
    if (rawId !== undefined && rawId !== null && rawId !== '') {
      if (!isUuid(rawId)) return json({ message: 'شناسهٔ سند نامعتبر است.', ok: false }, 400)
      docId = rawId
      const existing = (await req.payload.findByID({
        collection,
        depth: 0,
        disableErrors: true,
        id: docId,
        overrideAccess: true,
        req,
      })) as unknown as null | Record<string, unknown>
      if (!existing || !docBelongsToSite(existing, siteId)) {
        return json({ message: 'سند متعلق به این سایت نیست.', ok: false }, 404)
      }
    }

    const access: EmbedAccess = body?.canPublish === true ? 'owner' : 'editor'
    const email = await ensureEmbedUser(req.payload, siteId, access)

    await pruneExpired(req.payload)
    const code = newEmbedCode()
    const grant: EmbedGrant = {
      email,
      expiresAt: Date.now() + EMBED_CODE_TTL_MS,
      siteId,
      target: embedTargetPath(collection as EmbedCollection, docId),
    }
    await req.payload.kv.set(embedCodeKey(code), grant)

    // The URL is the secret for 60 seconds: it is returned once and never logged.
    req.payload.logger.info({ access, collection, msg: 'embed session minted', siteId })

    const url = new URL('/api/embed/enter', getServerSideURL())
    url.searchParams.set('code', code)
    return json({ expiresInSeconds: EMBED_CODE_TTL_MS / 1000, ok: true, url: url.toString() })
  },
}

const deny = (status: number): Response =>
  new Response('Forbidden', {
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    status,
  })

const isSecureRequest = (req: PayloadRequest): boolean => {
  if (process.env.NODE_ENV === 'production') return true
  const proto = req.headers.get('x-forwarded-proto')
  if (proto) return proto.split(',')[0]?.trim() === 'https'
  try {
    return new URL(req.url ?? '').protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * `GET /api/embed/enter?code=` — spends a one-time code, signs the service user in and
 * lands the iframe on the admin document.
 *
 * Unauthenticated by design: the 256-bit code *is* the credential. It is read and
 * deleted before anything else, so a replay finds nothing. The landing path comes from
 * the stored grant, not from the request.
 */
export const embedEnterEndpoint: Endpoint = {
  path: '/embed/enter',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const payload = req.payload
    let code = ''
    try {
      code = new URL(req.url ?? '', 'http://localhost').searchParams.get('code') ?? ''
    } catch {
      return deny(400)
    }
    if (code.length < 32 || code.length > 128) return deny(403)

    const key = embedCodeKey(code)
    const grant = await payload.kv.get<EmbedGrant>(key)
    // Delete first, decide second: a second request with the same code must find nothing
    // whether or not this one turns out to be valid.
    await payload.kv.delete(key)
    if (!grant || grant.expiresAt <= Date.now()) return deny(403)

    const password = embedUserPassword(payload.secret, grant.email)
    const login = async () =>
      payload.login({ collection: 'users', data: { email: grant.email, password }, depth: 0 })

    let result
    try {
      result = await login()
    } catch {
      // The password is derived from the server secret; a rotated secret (or an owner
      // who reset the account) lands here once and is healed.
      try {
        const user = (
          await payload.find({
            collection: 'users',
            depth: 0,
            limit: 1,
            overrideAccess: true,
            pagination: false,
            where: { email: { equals: grant.email } },
          })
        ).docs[0]
        if (!user) return deny(403)
        await payload.update({
          collection: 'users',
          data: { password },
          depth: 0,
          id: user.id,
          overrideAccess: true,
        })
        result = await login()
      } catch (error) {
        payload.logger.error({ err: error as Error, msg: 'embed login failed' })
        return deny(403)
      }
    }

    if (!result.token) return deny(403)

    const maxAge = Math.max(60, (result.exp ?? 0) - Math.floor(Date.now() / 1000))
    const secure = isSecureRequest(req)
    const headers = new Headers({
      'cache-control': 'no-store',
      location: grant.target,
      'referrer-policy': 'no-referrer',
    })
    headers.append(
      'set-cookie',
      serializeEmbedCookie(
        { httpOnly: true, maxAge, name: `${payload.config.cookiePrefix}-token`, value: result.token },
        secure,
      ),
    )
    // The plugin reads this to pick the tenant; the service user has exactly one, but
    // the admin's own site selector is hidden only once the cookie says which.
    headers.append(
      'set-cookie',
      serializeEmbedCookie({ httpOnly: false, maxAge, name: TENANT_COOKIE, value: grant.siteId }, secure),
    )
    headers.append(
      'set-cookie',
      serializeEmbedCookie({ httpOnly: true, maxAge, name: EMBED_MARKER_COOKIE, value: '1' }, secure),
    )

    return new Response(null, { headers, status: 302 })
  },
}

export const platformEmbedEndpoints: Endpoint[] = [platformSiteEmbedSessionEndpoint, embedEnterEndpoint]
