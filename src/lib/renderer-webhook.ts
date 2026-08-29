import { createHmac } from 'node:crypto'

import type { PayloadRequest } from 'payload'

/**
 * Tell the *other* renderers that a site's content changed.
 *
 * `revalidatePath` clears this app's Next.js cache. A separately deployed site builder
 * (WAVE-9) has its own cache — ISR entries, an edge KV, a static export waiting for a
 * rebuild — and nothing in this process can reach it. Without this call the editor
 * publishes, sees the change in the admin's preview, and a customer keeps reading
 * yesterday's price on the real domain.
 *
 * ## The contract
 *
 * ```
 * POST $REVALIDATE_WEBHOOK_URL
 *   content-type: application/json
 *   x-eshobe-signature: sha256=<hex hmac of the raw body, keyed by PAYLOAD_SECRET>
 *   { "paths": ["/acme.ir/en/pricing"], "siteId": "…", "timestamp": "ISO-8601" }
 * ```
 *
 * The receiver must verify the signature over the raw body before acting: an
 * unauthenticated endpoint that purges caches is a denial-of-service button, and
 * "invalidate everything" is one leaked URL away.
 *
 * ## Best effort, deliberately
 *
 * Fire-and-forget with a 3s timeout and a warning on failure: a save must not hang or
 * fail because a third-party cache endpoint is down. The cost is at-most-once delivery —
 * a missed ping means stale content until the next publish or the receiver's own TTL.
 * When that stops being acceptable the fix is a task on the jobs queue (already
 * configured, already retried), not a retry loop here.
 */
const TIMEOUT_MS = 3_000

export type RendererNotice = { paths: string[]; siteId: string }

export const notifyRenderers = ({ paths, req, siteId }: RendererNotice & { req: PayloadRequest }): void => {
  const url = process.env.REVALIDATE_WEBHOOK_URL

  if (!url || !paths.length) return

  const secret = process.env.PAYLOAD_SECRET

  if (!secret) {
    req.payload.logger.warn({ msg: 'renderer webhook: PAYLOAD_SECRET unset, notice skipped' })

    return
  }

  const body = JSON.stringify({ paths, siteId, timestamp: new Date().toISOString() })
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

  void fetch(url, {
    body,
    headers: {
      'content-type': 'application/json',
      'x-eshobe-signature': signature,
    },
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((response) => {
      if (!response.ok) {
        req.payload.logger.warn({ msg: `renderer webhook: ${response.status} from ${url}` })
      }
    })
    .catch((error: unknown) => {
      req.payload.logger.warn({
        msg: `renderer webhook unreachable: ${(error as Error)?.message ?? 'unknown'}`,
      })
    })
}
