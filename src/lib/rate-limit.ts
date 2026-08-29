/**
 * A fixed-window counter, in this process.
 *
 * In-memory is the right size for this deployment on purpose: PLAN §6 runs one web
 * container on one VPS, so there is no second replica to disagree with, and a shared
 * store (Redis) would be a new moving part to keep alive for a limit measured in tens of
 * requests. The consequence is written down where someone will hit it: **behind more
 * than one replica the limit is per-replica**, and the fix is a shared bucket, not a
 * bigger number here.
 *
 * It is a throttle, not a queue: no async, no timers, no cleanup job. Expired keys are
 * swept when the map grows, so a scan-bot cannot make this dictionary into a memory
 * leak by spraying unique IPs.
 */

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

const SWEEP_AT = 5_000

export type RateLimit = { allowed: true; remaining: number } | { allowed: false; retryAfterSeconds: number }

export const consume = ({
  key,
  limit,
  now = Date.now(),
  windowMs,
}: {
  key: string
  limit: number
  now?: number
  windowMs: number
}): RateLimit => {
  if (limit <= 0) return { allowed: true, remaining: 0 }

  const bucket = buckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > SWEEP_AT) sweep(now)

    buckets.set(key, { count: 1, resetAt: now + windowMs })

    return { allowed: true, remaining: limit - 1 }
  }

  bucket.count += 1

  if (bucket.count > limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
  }

  return { allowed: true, remaining: limit - bucket.count }
}

const sweep = (now: number): void => {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

/** Tests only: a shared bucket across files would make assertion order matter. */
export const resetRateLimits = (): void => {
  buckets.clear()
}

/**
 * The client address, as best a proxy-fronted app can know it.
 *
 * `x-forwarded-for`'s first entry is the original client *only* because Caddy sets it;
 * with no proxy in front (dev, and any deployment where someone can reach the node
 * directly) the header is attacker-supplied. That is acceptable for a throttle whose
 * cost is a few extra rows, and is why this is a rate limit and not an allowlist.
 */
export const clientKey = (headers: Headers): string => {
  const forwarded = headers.get('x-forwarded-for')

  if (forwarded) return forwarded.split(',')[0]!.trim()

  return headers.get('x-real-ip') ?? 'unknown'
}
