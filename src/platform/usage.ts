import type { PayloadRequest } from 'payload'

import { currentMonthWindow, type QuotaMetric } from '@/lib/saas/plans'

/**
 * Incrementing a metered counter.
 *
 * One row per `(site, metric, period)`, read-modify-written. The precision trade is
 * documented on the collection itself (`src/collections/UsageRecords.ts`): concurrent
 * increments can lose a count, and for a *quota* that is the correct direction to be
 * wrong — undercounting gives a customer a few free requests, overcounting blocks
 * work they paid for.
 *
 * Never throws. A counter is telemetry riding along with a real request; a failed
 * increment must not fail the request it was counting.
 */
export const recordUsage = async (
  req: PayloadRequest,
  args: { amount?: number; metric: QuotaMetric; siteId: string },
): Promise<void> => {
  const amount = Math.max(1, Math.trunc(args.amount ?? 1))
  const period = currentMonthWindow().start.slice(0, 7)

  try {
    const { docs } = await req.payload.find({
      collection: 'usage-records',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [
          { site: { equals: args.siteId } },
          { metric: { equals: args.metric } },
          { period: { equals: period } },
        ],
      },
    })

    const existing = docs[0] as { id?: unknown; value?: unknown } | undefined

    if (existing?.id) {
      await req.payload.update({
        id: String(existing.id),
        collection: 'usage-records',
        data: { lastEventAt: new Date().toISOString(), value: (Number(existing.value ?? 0) || 0) + amount },
        depth: 0,
        overrideAccess: true,
        req,
      })
      return
    }

    await req.payload.create({
      collection: 'usage-records',
      data: {
        lastEventAt: new Date().toISOString(),
        metric: args.metric,
        period,
        site: args.siteId,
        value: amount,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: `usage increment failed for ${args.metric}` })
  }
}

/**
 * Prune counters older than `keepMonths`.
 *
 * Usage rows are the only table here that grows without an operator doing anything,
 * and a counter from two years ago answers no question the platform asks. Called
 * from the maintenance endpoint rather than a cron, because a delete loop on a
 * one-minute timer is a worse failure mode than one an operator triggers.
 */
export const pruneUsage = async (req: PayloadRequest, keepMonths = 24): Promise<number> => {
  const now = new Date()
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - keepMonths, 1))
    .toISOString()
    .slice(0, 7)

  const { docs } = await req.payload.find({
    collection: 'usage-records',
    depth: 0,
    limit: 500,
    overrideAccess: true,
    pagination: false,
    req,
    where: { period: { less_than: cutoff } },
  })

  let removed = 0
  for (const doc of docs) {
    try {
      await req.payload.delete({ id: String(doc.id), collection: 'usage-records', depth: 0, overrideAccess: true, req })
      removed += 1
    } catch (error) {
      req.payload.logger.error({ err: error as Error, msg: 'usage prune failed' })
    }
  }

  return removed
}
