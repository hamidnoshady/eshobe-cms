import { APIError } from 'payload'

/**
 * The two boundaries an MCP endpoint needs that Payload does not already provide.
 *
 * Payload's own `rateLimit` is keyed on the client IP, which is the wrong identity
 * here: an assistant may connect from anywhere, and one tenant's runaway loop would
 * be charged to whatever address it egresses from — or, worse, not charged at all
 * because every request looks new. The credential is the thing that must be
 * bounded, so the bucket is the `payload-mcp-api-keys` row.
 *
 * Both limits are read **per call** (the same rule as `CHECKOUT_RATE_LIMIT` in
 * `src/endpoints/checkout.ts`). A module-level constant captured at import time
 * cannot be tuned or tested.
 *
 * ## What this is not
 *
 * The counters live in process memory. With two web replicas the effective limit is
 * twice the configured one, and a restart forgets a window. That is stated rather
 * than hidden: the purpose is stopping a runaway loop and a single oversized
 * request, not metering a customer. Anything that must hold across replicas belongs
 * in a shared store, which this deployment does not have.
 */

const DEFAULT_RATE_LIMIT = 120
const DEFAULT_MAX_BODY_BYTES = 256 * 1024
const WINDOW_MS = 60_000

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

/** Bounded so a long-lived process cannot grow this map without limit. */
const MAX_BUCKETS = 10_000

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export const mcpRateLimit = (): number =>
  positiveInt(process.env.MCP_RATE_LIMIT, DEFAULT_RATE_LIMIT)

export const mcpMaxBodyBytes = (): number =>
  positiveInt(process.env.MCP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES)

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  /** Milliseconds until the window resets — what a caller should wait before retrying. */
  retryAfterMs: number
}

/**
 * Count one request against a key's window.
 *
 * `now` is a parameter so the window is testable without a clock: the whole point of
 * a limiter is behaviour at a boundary, and a test that sleeps for a minute is a
 * test nobody runs.
 */
export const consumeMcpRateLimit = (
  keyId: number | string,
  now: number = Date.now(),
  limit: number = mcpRateLimit(),
): RateLimitDecision => {
  const bucketKey = String(keyId)
  const existing = buckets.get(bucketKey)

  if (!existing || existing.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      // Drop windows that have already expired; if none have, the map is full of
      // live keys, and forgetting the oldest window is better than unbounded memory.
      for (const [id, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(id)
      }
      if (buckets.size >= MAX_BUCKETS) buckets.clear()
    }
    buckets.set(bucketKey, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true, remaining: limit - 1, retryAfterMs: WINDOW_MS }
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, existing.resetAt - now) }
  }

  existing.count += 1
  return {
    allowed: true,
    remaining: Math.max(0, limit - existing.count),
    retryAfterMs: Math.max(0, existing.resetAt - now),
  }
}

/** Test seam: forget every window. Never called by the application. */
export const resetMcpRateLimits = (): void => {
  buckets.clear()
}

/**
 * Refuse an oversized request before the body is parsed.
 *
 * `Content-Length` is the only signal available this early, and a client that omits
 * it is bounded by the transport instead — this is a cheap first gate, not the only
 * one.
 */
export const assertBodyWithinLimit = (
  contentLength: string | null,
  limit: number = mcpMaxBodyBytes(),
): void => {
  if (!contentLength) return
  const declared = Number.parseInt(contentLength, 10)
  if (!Number.isFinite(declared) || declared < 0) return
  if (declared > limit) {
    throw new APIError('Request body too large.', 413)
  }
}
