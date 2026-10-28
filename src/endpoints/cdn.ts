import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
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
import { findCdnZoneWithSecret, withCdnCredentials } from '@/cdn/resolve'
import {
  assertZoneBelongsToSite,
  mergeTenantRecords,
  parseTenantRecords,
  templateRecords,
  TenantCdnRefusal,
  type ZoneRecord,
} from '@/cdn/tenant'
import { normalizeDomain } from '@/lib/domains'
import { siteForDomainKey } from './updateSiteDomain'

const noStore = { 'cache-control': 'no-store' }
const response = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

const body = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  await addDataAndFileToRequest(req)
  return (req.data ?? {}) as Record<string, unknown>
}

/**
 * Staff, for the platform-wide CDN operations (`/cdn/status`, `/cdn/sync`, `/cdn/purge`).
 * A `role: "platform"` key counts, so the operator console that drives the rest of this
 * deployment over the API (`src/endpoints/platformControl.ts`) can drive these too. The
 * per-site pair further down is site-key work and is unchanged.
 */
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
    const result = await syncCdnZone(await withCdnCredentials(req, raw))
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
    const result = await purgeCdnZone(await withCdnCredentials(req, raw), urls)
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
      managedBy: true,
      provider: true,
      providerNameservers: true,
      providerStatus: true,
      site: true,
      syncRequestedAt: true,
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
      managedBy: null,
      nameservers: [],
      ok: true,
      provider: null,
      providerStatus: null,
      records: [],
      selfService: await selfServiceProviders(req),
      syncPending: false,
      zoneName: null,
    })
  }

  const nameservers = (zone.providerNameservers ?? [])
    .map((entry) => (typeof entry?.hostname === 'string' ? entry.hostname : ''))
    .filter(Boolean)

  // Only the shape of a record — never a provider id, never a credential. A
  // tenant's own row also carries its row `id`, which is what `PUT
  // /api/site/cdn/records` matches on to update rather than duplicate it.
  const managedBy = zone.managedBy === 'tenant' ? 'tenant' : 'platform'
  const records = (zone.dnsRecords ?? []).map((record) => {
    const editable = managedBy === 'tenant' && record.source === 'tenant'
    return {
      content: String(record.content ?? ''),
      editable,
      ...(editable
        ? { id: record.id ?? null, priority: record.priority ?? null, ttl: record.ttl ?? null }
        : {}),
      name: String(record.name ?? ''),
      proxied: record.proxied ?? null,
      type: String(record.type ?? ''),
    }
  })

  return response({
    active: zone.active === true,
    configured: true,
    lastPurgeAt: zone.lastPurgeAt ?? null,
    lastSyncAt: zone.lastSyncAt ?? null,
    lastSyncDetail: zone.lastSyncDetail ?? null,
    lastSyncOk: zone.lastSyncOk ?? null,
    managedBy,
    nameservers,
    ok: true,
    provider: zone.provider ?? null,
    providerStatus: zone.providerStatus ?? null,
    records,
    syncPending: Boolean(zone.syncRequestedAt),
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

  const raw = await findCdnZoneWithSecret(req, { site: { equals: site.id } })

  if (!raw) return response({ message: 'برای این سایت CDN تنظیم نشده است.', ok: false }, 404)
  // A zone the platform has not switched on manages nothing at the provider
  // yet; purging it would be a call that silently does nothing.
  if (raw.active !== true) {
    return response({ message: 'CDN این سایت هنوز فعال نشده است.', ok: false }, 409)
  }

  const zone = cdnZoneInput(raw)
  try {
    const result = await purgeCdnZone(await withCdnCredentials(req, raw), urls)
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
    await audit(
      req,
      zone,
      'purge',
      false,
      error instanceof Error ? error.message : 'CDN purge failed',
    )
    req.payload.logger.warn({
      err: error as Error,
      msg: `CDN purge failed for ${zone.provider}:${zone.zoneName}`,
    })
    // The tenant is told it failed, not *how*: a purge error can name the
    // provider account behind the site.
    return response({ message: 'پاک‌سازی کش انجام نشد.', ok: false }, 502)
  }
}

/* ------------------------------------------------------------------ */
/* Tenant self-service on the platform's shared CDN account             */
/* ------------------------------------------------------------------ */

const forbiddenForSite = () =>
  response({ message: 'این عملیات فقط با کلید API همان سایت ممکن است.', ok: false }, 403)

const refusal = (error: unknown): null | Response =>
  error instanceof TenantCdnRefusal
    ? response({ message: error.message, ok: false }, error.status)
    : null

/** Which providers a tenant may self-serve on. Provider names only — the account
 * row, its id and its token never leave this module. */
const selfServiceProviders = async (req: PayloadRequest): Promise<string[]> => {
  const found = await req.payload.find({
    collection: 'cdn-accounts',
    depth: 0,
    limit: 10,
    overrideAccess: true,
    pagination: false,
    req,
    select: { provider: true },
    where: { and: [{ tenantSelfService: { equals: true } }, { enabled: { equals: true } }] },
  })
  return [...new Set(found.docs.map((doc) => String(doc.provider)))].sort()
}

/** The caller's own zone, located by the key's site and nothing else — no request
 * ever names a zone id, so there is no id to swap for another tenant's. */
const ownZone = async (req: PayloadRequest, siteId: string) => {
  const found = await req.payload.find({
    collection: 'cdn-zones',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    select: {
      dnsRecords: true,
      lastSyncAt: true,
      managedBy: true,
      pendingRecordDeletes: true,
      syncRequestedAt: true,
      zoneName: true,
    },
    where: { site: { equals: siteId } },
  })
  return found.docs[0] ?? null
}

const notSelfServed = () =>
  response(
    { message: 'CDN این سایت توسط پشتیبانی مدیریت می‌شود و از اینجا قابل تغییر نیست.', ok: false },
    409,
  )

/** Hostnames of every *other* site that could fall inside `zoneName`. `contains`
 * over-selects (`acme.ir` matches `notacme.ir`); `assertZoneBelongsToSite` does the
 * exact suffix test. */
const otherSitesHostnames = async (
  req: PayloadRequest,
  siteId: string,
  zoneName: string,
): Promise<string[]> => {
  const found = await req.payload.find({
    collection: 'sites',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
    select: { domain: true, domains: true },
    where: {
      and: [
        { id: { not_equals: siteId } },
        {
          or: [{ domain: { contains: zoneName } }, { 'domains.hostname': { contains: zoneName } }],
        },
      ],
    },
  })
  return found.docs.flatMap((doc) => [
    String(doc.domain ?? ''),
    ...((doc.domains ?? []) as Array<{ hostname?: null | string }>).map((row) =>
      String(row?.hostname ?? ''),
    ),
  ])
}

/**
 * `POST /api/site/cdn/zone { zoneName, provider? }` — put one of this site's own
 * hostnames behind the platform's shared CDN account.
 *
 * Site key only. The zone name must be a hostname of this site (or its immediate
 * parent) and no other site may hold a hostname inside it. The records written are
 * the platform's template — this site's hostnames, proxied, pointing at the
 * operator's origin — and TLS/cache/WAF take the collection's safe defaults. The
 * provider work happens in the `cdnZoneSync` task, so this answers `202` at once;
 * `GET /api/site/cdn` shows the nameservers to set at the registrar once it ran.
 */
export const siteCdnCreateZone: Endpoint['handler'] = async (req) => {
  const site = await siteForDomainKey(req)
  if (!site) return forbiddenForSite()

  const data = await body(req)
  const requested = typeof data.provider === 'string' ? data.provider : null
  const accounts = await req.payload.find({
    collection: 'cdn-accounts',
    depth: 0,
    limit: 10,
    overrideAccess: true,
    pagination: false,
    req,
    select: { originTarget: true, provider: true },
    where: { and: [{ tenantSelfService: { equals: true } }, { enabled: { equals: true } }] },
  })
  const candidates = accounts.docs.filter((doc) => !requested || doc.provider === requested)
  if (!candidates.length)
    return response(
      { message: 'افزودن دامنه به CDN برای این ارائه‌دهنده فعال نیست.', ok: false },
      409,
    )
  if (candidates.length > 1)
    return response({ message: 'ارائه‌دهنده (provider) را مشخص کنید.', ok: false }, 400)
  const account = candidates[0]!

  if (await ownZone(req, String(site.id)))
    return response({ message: 'این سایت از قبل یک zone CDN دارد.', ok: false }, 409)

  let zoneName: string
  let dnsRecords: ZoneRecord[]
  try {
    const candidate = typeof data.zoneName === 'string' ? normalizeDomain(data.zoneName) : ''
    zoneName = assertZoneBelongsToSite(
      site,
      candidate,
      candidate ? await otherSitesHostnames(req, String(site.id), candidate) : [],
    )
    dnsRecords = templateRecords(site, zoneName, String(account.originTarget ?? ''))
  } catch (error) {
    const refused = refusal(error)
    if (refused) return refused
    throw error
  }

  try {
    await req.payload.create({
      collection: 'cdn-zones',
      data: {
        account: account.id,
        active: true,
        dnsRecords,
        managedBy: 'tenant',
        provider: account.provider,
        provisionIfMissing: true,
        site: site.id,
        syncRequestedAt: new Date().toISOString(),
        zoneName,
      } as never,
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    // Unique zone name / provider-zone key: the domain is already some site's zone.
    // Which site is not the caller's business.
    req.payload.logger.warn({
      err: error as Error,
      msg: `tenant CDN zone create refused for ${zoneName}`,
    })
    return response({ message: 'این دامنه از قبل در CDN ثبت شده است.', ok: false }, 409)
  }

  return response({ ok: true, provider: account.provider, state: 'queued', zoneName }, 202)
}

/**
 * `PUT /api/site/cdn/records { records: [...] }` — replace this site's *own* DNS
 * records in its self-served zone. The full desired list: a row omitted is
 * deleted at the provider on the next sync (only if the CMS created it). Every
 * row is DNS-only; platform rows are untouched and cannot be shadowed.
 */
export const siteCdnPutRecords: Endpoint['handler'] = async (req) => {
  const site = await siteForDomainKey(req)
  if (!site) return forbiddenForSite()
  const zone = await ownZone(req, String(site.id))
  if (!zone) return response({ message: 'برای این سایت CDN تنظیم نشده است.', ok: false }, 404)
  if (zone.managedBy !== 'tenant') return notSelfServed()

  const data = await body(req)
  const stored = (zone.dnsRecords ?? []) as ZoneRecord[]
  let merged
  try {
    const tenant = parseTenantRecords(
      data.records,
      String(zone.zoneName),
      stored.filter((record) => record.source !== 'tenant'),
    )
    merged = mergeTenantRecords(stored, tenant)
  } catch (error) {
    const refused = refusal(error)
    if (refused) return refused
    throw error
  }

  const pending = [
    ...((zone.pendingRecordDeletes ?? []) as Array<{ providerRecordId?: null | string }>)
      .map((row) => row.providerRecordId)
      .filter((id): id is string => typeof id === 'string' && Boolean(id)),
    ...merged.removedProviderRecordIds,
  ]
  await req.payload.update({
    id: zone.id,
    collection: 'cdn-zones',
    data: {
      dnsRecords: merged.dnsRecords,
      pendingRecordDeletes: [...new Set(pending)].map((providerRecordId) => ({ providerRecordId })),
      syncRequestedAt: new Date().toISOString(),
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return response({ ok: true, records: merged.dnsRecords.length, state: 'queued' }, 202)
}

/** A re-check costs several provider calls, so one per minute per zone. */
const RESYNC_INTERVAL_MS = 60_000

/** `POST /api/site/cdn/sync` — ask for a re-check of a self-served zone (has the
 * registrar picked up the nameservers yet?). Queued, idempotent, rate-limited. */
export const siteCdnRequestSync: Endpoint['handler'] = async (req) => {
  const site = await siteForDomainKey(req)
  if (!site) return forbiddenForSite()
  const zone = await ownZone(req, String(site.id))
  if (!zone) return response({ message: 'برای این سایت CDN تنظیم نشده است.', ok: false }, 404)
  if (zone.managedBy !== 'tenant') return notSelfServed()
  if (zone.syncRequestedAt) return response({ ok: true, state: 'queued' }, 202)
  const last = zone.lastSyncAt ? Date.parse(String(zone.lastSyncAt)) : 0
  if (Date.now() - last < RESYNC_INTERVAL_MS)
    return response({ message: 'کمی بعد دوباره تلاش کنید.', ok: false }, 429)

  await req.payload.update({
    id: zone.id,
    collection: 'cdn-zones',
    data: { syncRequestedAt: new Date().toISOString() } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return response({ ok: true, state: 'queued' }, 202)
}

/**
 * `DELETE /api/site/cdn/zone` — detach this site's self-served zone. Deliberately
 * changes nothing at the provider: the domain's nameservers still point there, and
 * deleting the remote zone would take the site offline. The operator cleans up the
 * account side; the tenant moves its nameservers back first.
 */
export const siteCdnDeleteZone: Endpoint['handler'] = async (req) => {
  const site = await siteForDomainKey(req)
  if (!site) return forbiddenForSite()
  const zone = await ownZone(req, String(site.id))
  if (!zone) return response({ message: 'برای این سایت CDN تنظیم نشده است.', ok: false }, 404)
  if (zone.managedBy !== 'tenant') return notSelfServed()

  await req.payload.delete({
    id: zone.id,
    collection: 'cdn-zones',
    depth: 0,
    overrideAccess: true,
    req,
  })
  return response({ ok: true, removed: zone.zoneName })
}

export const cdnEndpoints: Endpoint[] = [
  { handler: cdnStatus, method: 'get', path: '/cdn/status' },
  { handler: cdnSync, method: 'post', path: '/cdn/sync' },
  { handler: cdnPurge, method: 'post', path: '/cdn/purge' },
  { handler: siteCdnStatus, method: 'get', path: '/site/cdn' },
  { handler: siteCdnPurge, method: 'post', path: '/site/cdn/purge' },
  { handler: siteCdnCreateZone, method: 'post', path: '/site/cdn/zone' },
  { handler: siteCdnDeleteZone, method: 'delete', path: '/site/cdn/zone' },
  { handler: siteCdnPutRecords, method: 'put', path: '/site/cdn/records' },
  { handler: siteCdnRequestSync, method: 'post', path: '/site/cdn/sync' },
]
