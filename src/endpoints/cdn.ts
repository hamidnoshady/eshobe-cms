import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import {
  cdnZoneInput,
  CdnConfigurationError,
  formatCdnActions,
  purgeCdnZone,
  syncCdnZone,
  writeCdnOperationalState,
} from '@/cdn/service'
import { CDN_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/cdnZoneSecrets'
import { isUuid } from '@/lib/ids'

const noStore = { 'cache-control': 'no-store' }
const response = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

const body = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  await addDataAndFileToRequest(req)
  return (req.data ?? {}) as Record<string, unknown>
}

const allowed = async (req: PayloadRequest): Promise<boolean> => {
  const { user } = await req.payload.auth({ headers: req.headers, req })
  return isPlatformAdminOrPlatformKey(req, isPlatformAdmin(user))
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
 * review it, then call this endpoint (or a platform automation may call it with a
 * platform API key). A site key never qualifies.
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

export const cdnEndpoints: Endpoint[] = [
  { handler: cdnStatus, method: 'get', path: '/cdn/status' },
  { handler: cdnSync, method: 'post', path: '/cdn/sync' },
  { handler: cdnPurge, method: 'post', path: '/cdn/purge' },
]
