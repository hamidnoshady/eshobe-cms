/**
 * Publisher backoff. Exponential, capped, with jitter so a fleet that failed
 * together does not retry together.
 */

export const MAX_PUBLISH_ATTEMPTS = 8
const BASE_MS = 1_000
const CAP_MS = 60 * 60 * 1_000

export const nextAttemptDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const exponent = Math.max(0, Math.min(attempt, 16))
  const base = Math.min(CAP_MS, BASE_MS * 2 ** exponent)
  const jitter = Math.floor(random() * base * 0.2)
  return base + jitter
}

export const isPermanentRejection = (reason: null | string | undefined): boolean => {
  if (!reason) return false
  return (
    reason === 'unknown_meter' ||
    reason === 'invalid_unit' ||
    reason === 'invalid_event' ||
    reason === 'contract_mismatch' ||
    reason === 'permanent'
  )
}

export type PublishOutcome = 'accepted' | 'duplicate' | 'rejected' | 'transient'

export const classifyPublishResult = (status: unknown, reason?: unknown): PublishOutcome => {
  if (status === 'accepted') return 'accepted'
  if (status === 'duplicate') return 'duplicate'
  if (status === 'rejected') return isPermanentRejection(typeof reason === 'string' ? reason : null) ? 'rejected' : 'transient'
  return 'transient'
}
