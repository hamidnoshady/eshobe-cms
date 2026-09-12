import type { PayloadRequest } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'
import { PLATFORM_EVENTS, type PlatformEventName } from '@/lib/saas/events'

/**
 * Writing the audit trail.
 *
 * Every control-plane mutation calls `recordAudit`. Two rules make it safe to call
 * from anywhere:
 *
 *  1. **It never throws.** An audit write failing must not turn a successful
 *     suspension into a 500 — the same rule `cdn.ts` applies to its own event
 *     writes, and the same best-effort shape as the renderer webhook. The cost is
 *     at-most-once, which is stated here rather than discovered later.
 *  2. **It never stores a credential.** `sanitizeChanges` truncates values and drops
 *     any field whose name looks like a secret. That list is a heuristic and is
 *     deliberately aggressive: a missing value in an audit row costs an operator one
 *     query, a leaked one costs a rotation.
 */

const SECRET_FIELD = /secret|password|token|credential|apikey|api_key|keyhash|privatekey|authorization/i

const MAX_VALUE_LENGTH = 200
const MAX_FIELDS = 40

/** A scalar, shortened. Objects and arrays collapse to a shape note — an audit row is a hint, not a copy. */
const summarizeValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value
  }
  if (Array.isArray(value)) return `[${value.length} مورد]`
  if (typeof value === 'object') return '{…}'
  return String(value)
}

export const sanitizeChanges = (
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Record<string, { from: unknown; to: unknown }> => {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])

  for (const key of keys) {
    if (Object.keys(changes).length >= MAX_FIELDS) break
    if (SECRET_FIELD.test(key)) continue
    if (key === 'updatedAt' || key === 'createdAt' || key === 'id') continue

    const from = before?.[key]
    const to = after?.[key]
    if (JSON.stringify(from) === JSON.stringify(to)) continue

    changes[key] = { from: summarizeValue(from), to: summarizeValue(to) }
  }

  return changes
}

/** The IP a proxy reported. Informational only — never an authentication input. */
const clientIp = (req: PayloadRequest): null | string => {
  const header = req.headers?.get?.('x-forwarded-for') ?? req.headers?.get?.('x-real-ip') ?? null
  if (!header) return null
  return header.split(',')[0]?.trim().slice(0, 64) || null
}

export type AuditInput = {
  action: PlatformEventName
  changes?: Record<string, unknown> | null
  site?: null | string | { id?: unknown }
  summary?: string
  targetCollection?: null | string
  targetId?: null | string
}

/**
 * Record one control-plane action.
 *
 * The actor is resolved from the request rather than passed in, so a caller cannot
 * attribute their action to somebody else: a session gives the user's email, a
 * bearer key gives the key's name, and neither gives the other.
 */
export const recordAudit = async (req: PayloadRequest, input: AuditInput): Promise<void> => {
  try {
    const key = req.user ? null : await requestApiKey(req)

    const actorType = req.user ? 'user' : key ? 'apiKey' : 'system'
    const actorEmail = req.user
      ? String((req.user as { email?: unknown }).email ?? '')
      : key
        ? `api-key:${key.id}`
        : null

    await req.payload.create({
      collection: 'audit-log',
      data: {
        action: input.action,
        actorEmail,
        actorType,
        changes: input.changes ?? null,
        ip: clientIp(req),
        site: idOf(input.site) ?? null,
        summary: (input.summary ?? PLATFORM_EVENTS[input.action]).slice(0, 500),
        targetCollection: input.targetCollection ?? null,
        targetId: input.targetId ?? null,
      },
      depth: 0,
      // The collection's `create` access is `false`: the only writer is this
      // function, which is what makes a forged audit entry impossible through the API.
      overrideAccess: true,
      req,
    })
  } catch (error) {
    // Best-effort, always. An audit failure must never fail the action it describes.
    req.payload.logger.error({ err: error as Error, msg: 'audit write failed' })
  }
}
