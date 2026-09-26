import type { PayloadRequest } from 'payload'

import { postUsageBatch } from '@/billing/client/publish'
import { isPermanentRejection } from '@/billing/usage/retry'
import {
  leaseOutboxBatch,
  markOutboxRetry,
  markOutboxSent,
  outboxEventToContract,
  recoverStaleSending,
} from '@/billing/usage/outbox'

export type PublishStats = {
  accepted: number
  duplicate: number
  dead: number
  leased: number
  recovered: number
  rejected: number
  transient: number
}

/**
 * One bounded pass: recover leases abandoned by a crashed worker, lease a
 * batch, post it, and apply each event's acknowledgement. Events the response
 * does not mention stay retryable — silence is not acceptance.
 */
export const publishUsageBatch = async (
  req: PayloadRequest,
  fetchImpl?: typeof fetch,
): Promise<PublishStats> => {
  const stats: PublishStats = {
    accepted: 0,
    dead: 0,
    duplicate: 0,
    leased: 0,
    recovered: 0,
    rejected: 0,
    transient: 0,
  }
  stats.recovered = await recoverStaleSending(req)
  const leased = await leaseOutboxBatch(req)
  stats.leased = leased.length
  if (leased.length === 0) return stats

  const docs = await Promise.all(
    leased.map((row) =>
      req.payload.findByID({
        id: row.id,
        collection: 'billing-usage-outbox',
        depth: 0,
        overrideAccess: true,
        req,
      }),
    ),
  )
  const events = docs.map((doc) => outboxEventToContract(doc as unknown as Record<string, unknown>))
  const posted = await postUsageBatch(req, events, fetchImpl)

  if (!posted.ok) {
    for (const row of leased) {
      await markOutboxRetry(req, row, posted.error, false)
      stats.transient += 1
    }
    req.payload.logger.error({ msg: `billing publish transient: ${posted.error}` })
    return stats
  }

  const byId = new Map(posted.results.map((result) => [result.eventId, result]))
  for (const [index, row] of leased.entries()) {
    const event = events[index]!
    const result = byId.get(event.eventId)
    if (!result) {
      await markOutboxRetry(req, row, 'ack omitted this event', false)
      stats.transient += 1
      continue
    }
    if (result.outcome === 'accepted' || result.outcome === 'duplicate') {
      await markOutboxSent(req, row, event.quantity)
      if (result.outcome === 'accepted') stats.accepted += 1
      else stats.duplicate += 1
      continue
    }
    const permanent = result.outcome === 'rejected' || isPermanentRejection(result.reason)
    await markOutboxRetry(req, row, result.reason ?? result.outcome, permanent)
    if (permanent) stats.dead += 1
    else stats.transient += 1
    if (result.outcome === 'rejected') stats.rejected += 1
  }
  return stats
}
