import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isUuid } from '@/lib/ids'
import {
  cdnZoneInput,
  CdnConfigurationError,
  formatCdnActions,
  purgeCdnZone,
  syncCdnZone,
  writeCdnOperationalState,
} from '@/cdn/service'
import { CDN_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/cdnZoneSecrets'
import { siteForDomainKey } from './updateSiteDomain'


const noStore = { 'cache-control': 'no-store' }
const response = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

const body = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  await addDataAndFileToRequest(req)
  return (req.data ?? {}) as Record<string, unknown>
}

const allowed = async (req: PayloadRequest): Promise<boolean> => {
  const { user } = await req.payload.auth({ headers: req.headers, req })
  return isPlatformAdmin(user)
}

/** Reads the one field that is write-only everywhere else. A request-context flag
 * is intentionally narrower than `overrideAccess`; the token still cannot leak
 * through an ordinary admin, REST, GraphQL or Local-API read. */
const zoneById = async (req: PayloadRequest, id: string) => {
  req.context[CDN_SECRET_READ_CONTEXT_KEY] = true
  try {
    return await req.payload.findByID({
      id,
      collection: 'cdn-zones',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })
  } finally {
    delete req.context[CDN_SECRET_READ_CONTEXT_KEY]
  }
}

const zoneId = (data: Record<string, unknown>): string | null =>
  typeof data.id === 'string' && isUuid(data.id) ? data.id : null

const audit = async (
  req: PayloadRequest,
  zone: ReturnType<typeof cdnZoneInput>,
  operation: 'purge' | 'sync',
  ok: boolean,
  summary: string,
): Promise<void> => {
  try {
    await req.payload.create({
      collection: 'cdn-events',
      data: { ok, operation, summary: summary.slice(0, 4000), zone: zone.id },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    // Audit storage must not turn a successfully applied provider change into an API failure.
    req.payload.logger.error({
      err: error as Error,
      msg: `could not write CDN ${operation} audit event for ${zone.id}`,
    })
  }
}

const operationalError = async (
  req: PayloadRequest,
  zone: ReturnType<typeof cdnZoneInput>,
  error: unknown,
): Promise<void> => {
  const message = error instanceof Error ? error.message.slice(0, 1000) : 'unknown provider failure'
  try {
    await writeCdnOperationalState(
      req.payload,
      req,
      zone,
      { actions: [], externalIds: {} },
      false,
      message,
    )
  } catch (stateError) {
    req.payload.logger.error({
      err: stateError as Error,
      msg: `could not record CDN sync failure for ${zone.id}`,
    })
  }
}

/**
 * POST /api/cdn/sync { id }
 *
 * An explicit operation, not an afterChange hook: a form save must never change
 * live DNS or WAF state by accident. Platform staff may first save desired state,
 * review it, then call this endpoint from their authenticated superadmin session.
 * API keys of every kind, including platform API keys, never qualify.
 */
export const cdnSync: Endpoint['handler'] = async (req) => {
  if (!(await allowed(req))) return response({ message: 'forbidden', ok: false }, 403)
  const id = zoneId(await body(req))
  if (!id) return response({ message: 'id must be a UUID', ok: false }, 400)

  const raw = await zoneById(req, id)
  if (!raw) return response({ message: 'cdn zone not found', ok: false }, 404)
  const zone = cdnZoneInput(raw)

  try {
    const result = await syncCdnZone(zone)
    const detail = formatCdnActions(result.actions)
    await writeCdnOperationalState(req.payload, req, zone, result, true, detail)
    await audit(req, zone, 'sync', true, detail)
    return response({
      actions: result.actions,
      ok: true,
      status: result.status,
      zone: zone.zoneName,
    })
  } catch (error) {
    await operationalError(req, zone, error)
    await audit(
      req,
      zone,
      'sync',
      false,
      error instanceof Error ? error.message : 'CDN sync failed',
    )
    const message = error instanceof Error ? error.message : 'CDN sync failed'
    req.payload.logger.warn({
      err: error as Error,
      msg: `CDN sync failed for ${zone.provider}:${zone.zoneName}`,
    })
    return response(
      { message, ok: false, zone: zone.zoneName },
      error instanceof CdnConfigurationError ? 409 : 502,
    )
  }
}

/** POST /api/cdn/purge { id, urls?: string[] }. A missing urls array purges the
 * whole zone, so the API response makes that fact unmistakable and is no-store. */
export const cdnPurge: Endpoint['handler'] = async (req) => {
  if (!(await allowed(req))) return response({ message: 'forbidden', ok: false }, 403)
  const data = await body(req)
  const id = zoneId(data)
  if (!id) return response({ message: 'id must be a UUID', ok: false }, 400)
  const urls =
    Array.isArray(data.urls) && data.urls.every((item) => typeof item === 'string')
      ? data.urls
      : null
  if (data.urls !== undefined && !urls)
    return response({ message: 'urls must be an array of strings', ok: false }, 400)

  const raw = await zoneById(req, id)
  if (!raw) return response({ message: 'cdn zone not found', ok: false }, 404)
  const zone = cdnZoneInput(raw)
  try {
    const result = await purgeCdnZone(zone, urls)
    await req.payload.update({
      id: zone.id,
      collection: 'cdn-zones',
      data: { lastPurgeAt: new Date().toISOString() },
      depth: 0,
      overrideAccess: true,
      req,
    })
    await audit(req, zone, 'purge', true, formatCdnActions(result.actions))
    return response({
      actions: result.actions,
      ok: true,
      scope: urls?.length ? 'urls' : 'everything',
      zone: zone.zoneName,
    })
  } catch (error) {
    await audit(
      req,
      zone,
      'purge',
      false,
      error instanceof Error ? error.message : 'CDN purge failed',
    )
    const message = error instanceof Error ? error.message : 'CDN purge failed'
    req.payload.logger.warn({
      err: error as Error,
      msg: `CDN purge failed for ${zone.provider}:${zone.zoneName}`,
    })
    return response(
      { message, ok: false, zone: zone.zoneName },
      error instanceof CdnConfigurationError ? 409 : 502,
    )
  }
}

/** GET /api/cdn/status — operational projection only. It deliberately reads a
 * narrow selected shape so adding a new credential field cannot accidentally make
 * it observable through this convenience endpoint. */
export const cdnStatus: Endpoint['handler'] = async (req) => {
  if (!(await allowed(req))) return response({ message: 'forbidden', ok: false }, 403)
  const found = await req.payload.find({
    collection: 'cdn-zones',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
    select: {
      active: true,
      lastPurgeAt: true,
      lastSyncAt: true,
      lastSyncDetail: true,
      lastSyncOk: true,
      provider: true,
      providerStatus: true,
      providerZoneId: true,
      site: true,
      zoneName: true,
    },
  })
  return response({ ok: true, zones: found.docs })
}


/* ------------------------------------------------------------------ */
/* Site-scoped — what a tenant may see and do about its own zone        */
/* ------------------------------------------------------------------ */

/**
 * `GET /api/site/cdn` — the operational state of the caller's own zone.
 *
 * Site key only, and read-only by construction. The builder (the POS/accounting
 * platform) walks an owner through putting their site behind ArvanCloud, and
 * that walk needs two facts it cannot invent: is there a zone yet, and which
 * nameservers or records must be set at the registrar. Both are observations,
 * so they are safe to hand a tenant.
 *
 * What is *not* safe, and stays platform-staff work behind a superadmin session
 * (`POST /api/cdn/sync`, which refuses every API key including a platform one):
 * creating a zone, and writing DNS, TLS or WAF state at the provider. This
 * endpoint therefore selects a narrow projection rather than the document —
 * adding a credential field later cannot accidentally make it observable here.
 *
 * A site with no zone is not an error: `configured: false` is the answer the
 * question is asking for.
 */
export const siteCdnStatus: Endpoint['handler'] = async (req) => {
  const site = await siteForDomainKey(req)
  if (!site) {
    return response({ message: 'این عملیات فقط با کلید API همان سایت ممکن است.', ok: false }, 403)
  }

  const found = await req.payload.find({
    collection: 'cdn-zones',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    select: {
      active: true,
      dnsRecords: true,
      lastPurgeAt: true,
      lastSyncAt: true,
      lastSyncDetail: true,
      lastSyncOk: true,
      provider: true,
      providerNameservers: true,
      providerStatus: true,
      site: true,
      zoneName: true,
    },
    where: { site: { equals: site.id } },
  })

  const zone = found.docs[0]
  if (!zone) {
    return response({
      active: false,
      configured: false,
      lastPurgeAt: null,
      lastSyncAt: null,
      lastSyncDetail: null,
      lastSyncOk: null,
      nameservers: [],
      ok: true,
      provider: null,
      providerStatus: null,
      records: [],
      zoneName: null,
    })
  }

  const nameservers = (zone.providerNameservers ?? [])
    .map((entry) => (typeof entry?.hostname === 'string' ? entry.hostname : ''))
    .filter(Boolean)

  // Only the shape of a record — never a provider id, never a credential.
  const records = (zone.dnsRecords ?? []).map((record) => ({
    content: String(record.content ?? ''),
    name: String(record.name ?? ''),
    proxied: record.proxied ?? null,
    type: String(record.type ?? ''),
  }))

  return response({
    active: zone.active === true,
    configured: true,
    lastPurgeAt: zone.lastPurgeAt ?? null,
    lastSyncAt: zone.lastSyncAt ?? null,
    lastSyncDetail: zone.lastSyncDetail ?? null,
    lastSyncOk: zone.lastSyncOk ?? null,
    nameservers,
    ok: true,
    provider: zone.provider ?? null,
    providerStatus: zone.providerStatus ?? null,
    records,
    zoneName: zone.zoneName ?? null,
  })
}

/**
 * `POST /api/site/cdn/purge` — empty this site's own edge cache.
 *
 * The one CDN *write* a tenant gets, and it is deliberately the one that
 * cannot hurt anybody: a purge drops cached copies of the site's own pages and
 * nothing else. Publishing already purges through the CMS's own hooks; this is
 * the "it is still showing the old price" button, and refusing it would push
 * owners to ask staff to run a platform-wide purge instead — a worse outcome
 * for the same operation.
 */
export const siteCdnPurge: Endpoint['handler'] = async (req) => {
  const site = await siteForDomainKey(req)
  if (!site) {
    return response({ message: 'این عملیات فقط با کلید API همان سایت ممکن است.', ok: false }, 403)
  }

  const data = await body(req)
  const urls =
    Array.isArray(data.urls) && data.urls.every((item) => typeof item === 'string')
      ? (data.urls as string[])
      : null
  if (data.urls !== undefined && !urls) {
    return response({ message: 'urls must be an array of strings', ok: false }, 400)
  }

  req.context[CDN_SECRET_READ_CONTEXT_KEY] = true
  let raw
  try {
    const found = await req.payload.find({
      collection: 'cdn-zones',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: { site: { equals: site.id } },
    })
    raw = found.docs[0]
  } finally {
    delete req.context[CDN_SECRET_READ_CONTEXT_KEY]
  }

  if (!raw) return response({ message: 'برای این سایت CDN تنظیم نشده است.', ok: false }, 404)
  // A zone the platform has not switched on manages nothing at the provider
  // yet; purging it would be a call that silently does nothing.
  if (raw.active !== true) {
    return response({ message: 'CDN این سایت هنوز فعال نشده است.', ok: false }, 409)
  }

  const zone = cdnZoneInput(raw)
  try {
    const result = await purgeCdnZone(zone, urls)
    await req.payload.update({
      id: zone.id,
      collection: 'cdn-zones',
      data: { lastPurgeAt: new Date().toISOString() },
      depth: 0,
      overrideAccess: true,
      req,
    })
    await audit(req, zone, 'purge', true, formatCdnActions(result.actions))
    return response({ ok: true, scope: urls?.length ? 'urls' : 'everything', zone: zone.zoneName })
  } catch (error) {
    await audit(req, zone, 'purge', false, error instanceof Error ? error.message : 'CDN purge failed')
    req.payload.logger.warn({
      err: error as Error,
      msg: `CDN purge failed for ${zone.provider}:${zone.zoneName}`,
    })
    // The tenant is told it failed, not *how*: a purge error can name the
    // provider account behind the site.
    return response({ message: 'پاک‌سازی کش انجام نشد.', ok: false }, 502)
  }
}

export const cdnEndpoints: Endpoint[] = [
  { handler: cdnStatus, method: 'get', path: '/cdn/status' },
  { handler: cdnSync, method: 'post', path: '/cdn/sync' },
  { handler: cdnPurge, method: 'post', path: '/cdn/purge' },
  { handler: siteCdnStatus, method: 'get', path: '/site/cdn' },
  { handler: siteCdnPurge, method: 'post', path: '/site/cdn/purge' },
]
