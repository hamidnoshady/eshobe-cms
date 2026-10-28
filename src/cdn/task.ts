import type { PayloadRequest, TaskConfig } from 'payload'

import { findCdnZoneWithSecret, withCdnCredentials } from './resolve'
import { deleteCdnRecords, formatCdnActions, syncCdnZone } from './service'
import type { CdnAction, CdnSyncResult } from './types'

/** Zones reconciled per tick. Each sync is several provider calls with a 15s
 * timeout apiece, so a burst of tenant requests is spread over minutes rather than
 * holding one tick (and the single web process running it) for all of them. */
const BATCH = 5

type Raw = Record<string, unknown>
type Row = Raw & { id?: string; providerRecordId?: null | string }

const audit = async (req: PayloadRequest, zoneId: string, ok: boolean, summary: string) => {
  try {
    await req.payload.create({
      collection: 'cdn-events',
      data: { ok, operation: 'sync', summary: summary.slice(0, 4000), zone: zoneId },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    req.payload.logger.error({
      err: error as Error,
      msg: `could not write CDN sync event for ${zoneId}`,
    })
  }
}

/**
 * Write the outcome onto the *current* row, not onto the snapshot the sync started
 * from: a tenant may have saved new records while the provider calls ran. Ids are
 * merged by row id, processed deletes are removed by value, and the request marker
 * is cleared only if nobody asked again in the meantime — a newer request stays
 * queued for the next tick instead of being swallowed.
 */
const recordOutcome = async (
  req: PayloadRequest,
  zoneId: string,
  requestedAt: unknown,
  deleted: string[],
  result: CdnSyncResult,
  ok: boolean,
  detail: string,
): Promise<void> => {
  const current = (await req.payload.findByID({
    id: zoneId,
    collection: 'cdn-zones',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as null | Raw
  if (!current) return

  const records = ((current.dnsRecords as Row[] | undefined) ?? []).map((row) => {
    const id = row.id ? result.externalIds[`dns:${row.id}`] : undefined
    return id ? { ...row, providerRecordId: id } : row
  })
  const pending = ((current.pendingRecordDeletes as Row[] | undefined) ?? []).filter(
    (row) => !deleted.includes(String(row.providerRecordId)),
  )

  await req.payload.update({
    id: zoneId,
    collection: 'cdn-zones',
    data: {
      dnsRecords: records,
      lastSyncAt: new Date().toISOString(),
      lastSyncDetail: detail.slice(0, 4000),
      lastSyncOk: ok,
      pendingRecordDeletes: pending,
      ...(current.syncRequestedAt === requestedAt ? { syncRequestedAt: null } : {}),
      ...(result.providerZoneId ? { providerZoneId: result.providerZoneId } : {}),
      ...(result.status ? { providerStatus: result.status } : {}),
      ...(result.nameservers
        ? { providerNameservers: result.nameservers.map((hostname) => ({ hostname })) }
        : {}),
    },
    depth: 0,
    overrideAccess: true,
    req,
  })
}

export const syncRequestedCdnZones = async (req: PayloadRequest): Promise<{ synced: number }> => {
  const queued = await req.payload.find({
    collection: 'cdn-zones',
    depth: 0,
    limit: BATCH,
    overrideAccess: true,
    pagination: false,
    req,
    select: { syncRequestedAt: true },
    sort: 'syncRequestedAt',
    where: { syncRequestedAt: { exists: true } },
  })

  let synced = 0
  for (const doc of queued.docs) {
    const zoneId = String(doc.id)
    const raw = await findCdnZoneWithSecret(req, { id: { equals: zoneId } })
    if (!raw) continue
    const requestedAt = raw.syncRequestedAt
    const deletes = ((raw.pendingRecordDeletes as Row[] | undefined) ?? [])
      .map((row) => row.providerRecordId)
      .filter((id): id is string => typeof id === 'string' && Boolean(id))

    const actions: CdnAction[] = []
    let deleted: string[] = []
    try {
      const zone = await withCdnCredentials(req, raw)
      if (deletes.length) {
        actions.push(...(await deleteCdnRecords(zone, deletes)))
        deleted = deletes
      }
      const result = await syncCdnZone(zone)
      actions.push(...result.actions)
      const detail = formatCdnActions(actions)
      await recordOutcome(req, zoneId, requestedAt, deleted, result, true, detail)
      await audit(req, zoneId, true, detail)
      synced += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CDN sync failed'
      req.payload.logger.warn({ err: error as Error, msg: `queued CDN sync failed for ${zoneId}` })
      // Cleared on failure too: a bad token or a refused zone would otherwise be
      // retried against the provider every minute, forever. The tenant sees
      // `lastSyncOk: false` and can ask again with `POST /api/site/cdn/sync`.
      try {
        await recordOutcome(
          req,
          zoneId,
          requestedAt,
          deleted,
          { actions: [], externalIds: {} },
          false,
          message.slice(0, 1000),
        )
      } catch (stateError) {
        req.payload.logger.error({
          err: stateError as Error,
          msg: `could not record CDN failure for ${zoneId}`,
        })
      }
      await audit(req, zoneId, false, message)
    }
  }
  return { synced }
}

export const cdnZoneSyncTask: TaskConfig<'cdnZoneSync'> = {
  slug: 'cdnZoneSync',
  handler: async ({ req }) => ({ output: await syncRequestedCdnZones(req) }),
  label: 'همگام‌سازی zoneهای CDN درخواست‌شده',
  outputSchema: [{ name: 'synced', type: 'number' }],
  schedule: [{ cron: '* * * * *', hooks: {}, queue: 'default' }],
  retries: 0,
}
