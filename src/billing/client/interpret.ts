/**
 * What central Billing is allowed to say back. Anything else is a transient
 * failure: the outbox row stays unsent until a response names the event.
 */

import type { PublishOutcome } from '@/billing/usage/retry'
import { classifyPublishResult } from '@/billing/usage/retry'

export type EventResult = {
  eventId: string
  outcome: PublishOutcome
  reason: null | string
}

export const parseBatchAck = (body: unknown): { error: string } | { results: EventResult[] } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'ack is not an object' }
  const raw = body as { contractVersion?: unknown; results?: unknown }
  if (raw.contractVersion !== undefined && raw.contractVersion !== 1) {
    return { error: 'ack contractVersion is not supported' }
  }
  const results = raw.results
  if (!Array.isArray(results)) return { error: 'ack has no results' }
  const parsed: EventResult[] = []
  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    const row = item as { eventId?: unknown; reason?: unknown; status?: unknown }
    if (typeof row.eventId !== 'string' || !row.eventId) continue
    parsed.push({
      eventId: row.eventId,
      outcome: classifyPublishResult(row.status, row.reason),
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 500) : null,
    })
  }
  return { results: parsed }
}

export const MAX_ACK_CHARS = 1_000_000
