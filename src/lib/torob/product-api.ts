/**
 * `POST /torob/v1/products` — the CMS runtime of Torob Product API v3 (issue #183).
 *
 * Order of operations is the security model:
 *   1. Resolve the tenant from the socket `Host` (never a forwarded host, never a body id).
 *   2. Refuse a site whose local enrollment projection is not connected+authorized+enabled.
 *   3. Verify Torob's EdDSA JWT against the site's *stored canonical domain*.
 *   4. Parse the body strictly.
 *   5. Only then read the published, site-scoped catalogue.
 *
 * No call to Biza Miz/Growth is made here. The enrollment projection is synced by the
 * platform control surface, so Growth UI uptime cannot take a shop's crawler endpoint down.
 */
import type { PayloadRequest } from 'payload'

import configPromise from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { hostFromHeader } from '@/lib/domains'
import { consume } from '@/lib/rate-limit'
import { findForSite, siteFromRequest } from '@/lib/site-query'
import { siteOrigin } from '@/lib/site-url'
import { storeSettingsForSite } from '@/lib/store'

import { torobAuthHeaders, verifyTorobToken } from './auth'
import { parseTorobRequest, torobErrorBody } from './contract'
import { torobEnrollmentServes } from './enrollment'
import { buildTorobCmsFeed, decodeTorobCursor, serveTorobFeed } from './feed'

export const TOROB_MAX_BODY_BYTES = 256 * 1024
export const TOROB_SHOP_LIMIT = 5
export const TOROB_SHOP_WINDOW_MS = 1_000

const noStore = { 'cache-control': 'no-store' }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { headers: { ...noStore, ...headers }, status })

const notFound = () => json({ error: 'not_found' }, 404)

export const torobBodyTooLarge = (contentLength: null | string): boolean => {
  if (!contentLength) return false
  const length = Number(contentLength)
  return Number.isFinite(length) && length > TOROB_MAX_BODY_BYTES
}

/** Read at most the cap, so a chunked body without Content-Length cannot spend unbounded memory. */
export const readTorobBody = async (request: Request): Promise<{ ok: true; text: string } | { ok: false }> => {
  if (torobBodyTooLarge(request.headers.get('content-length'))) return { ok: false }
  const reader = request.body?.getReader()
  if (!reader) return { ok: true, text: '' }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    size += value.byteLength
    if (size > TOROB_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return { ok: false }
    }
    chunks.push(value)
  }
  const buffer = Buffer.concat(chunks)
  return { ok: true, text: buffer.toString('utf8') }
}

export const handleTorobProductRequest = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' })
  }

  // Throttle before the tenant lookup, keyed on the normalized socket host. The host
  // is not an authority here (the audience comes from the stored row below); it is only
  // the bucket name, so a flood of unknown hosts cannot spend a real shop's budget.
  const hostBucket = hostFromHeader(request.headers.get('host')) || 'unknown'
  const limit = consume({
    key: `torob:host:${hostBucket}`,
    limit: TOROB_SHOP_LIMIT,
    windowMs: TOROB_SHOP_WINDOW_MS,
  })
  if (!limit.allowed) {
    return json({ error: 'too_many_requests' }, 429, { 'retry-after': String(limit.retryAfterSeconds) })
  }

  const payload = await getPayload({ config: configPromise })
  const req = await createLocalReq(
    {
      req: {
        headers: request.headers,
        method: 'POST',
        url: request.url,
      } as Partial<PayloadRequest>,
    },
    payload,
  )
  const site = await siteFromRequest(req)
  if (!site) return notFound()

  // Unknown, disconnected, unauthorized, disabled, suspended or non-store: one answer.
  if (!torobEnrollmentServes(site)) return notFound()

  const auth = await verifyTorobToken({
    ...torobAuthHeaders(request.headers),
    expectedHost: site.domain,
  })
  if (!auth.ok) return json({ error: `unauthorized: ${auth.reason}` }, 401)

  const body = await readTorobBody(request)
  if (!body.ok) return json({ error: 'request body too large' }, 413)

  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(body.text)
  } catch {
    return json({ error: 'request body must be JSON' }, 400)
  }
  const parsed = parseTorobRequest(parsedBody)
  if (!parsed.ok) return json(torobErrorBody(parsed.error), 400)
  if (
    parsed.request.mode === 'cursor' &&
    parsed.request.cursor !== null &&
    decodeTorobCursor(parsed.request.cursor) === null
  ) {
    return json(torobErrorBody('cursor_invalid'), 400)
  }

  const siteId = String(site.id)
  const [{ docs: products }, store] = await Promise.all([
    findForSite('products', siteId, {
      depth: 1,
      draft: false,
      fallbackLocale: false,
      locale: site.defaultLocale,
      pagination: false,
      sort: 'createdAt',
      where: { _status: { equals: 'published' } },
    }),
    storeSettingsForSite(siteId, { locale: site.defaultLocale }),
  ])

  const feed = buildTorobCmsFeed({
    currency: store.currency,
    origin: siteOrigin(site),
    products,
    site,
  })
  return json(serveTorobFeed(feed, parsed.request))
}

