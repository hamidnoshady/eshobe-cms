import { createHmac } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { decryptDeploySecret } from '@/lib/deploy/crypto'
import { applicationHostOf } from '@/lib/deploy/status'

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
 * POST <each target's URL>
 *   content-type: application/json
 *   x-eshobe-timestamp: <ISO-8601>              (sent, NOT signed — see `signRendererBody`)
 *   x-eshobe-signature: sha256=<hex HMAC-SHA256(secret, raw body)>
 *   { "paths": ["/acme.ir/en/pricing"], "resources": ["page"], "tags": [], "siteId": "…", "timestamp": "ISO-8601" }
 * ```
 *
 * The signature covers the raw body bytes and nothing else — the v1 contract in
 * `docs/THEME_API.md` §17, which deployed themes verify byte for byte.
 *
 * The key depends on the target: a deployment managed here signs with that
 * deployment's own `ESHOBE_REVALIDATE_SECRET`, and the `REVALIDATE_WEBHOOK_URL`
 * fallback signs with `PAYLOAD_SECRET`. See `rendererEndpointsFor` for why those are
 * not the same secret.
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

export type RendererNotice = {
  paths: string[]
  /** Additive v1 metadata. Old renderers may continue to consume only `paths`. */
  resources?: string[]
  tags?: string[]
  siteId: string
}

/** One place a notice is sent: a URL and the secret its signature is keyed by. */
export type RendererEndpoint = { secret: string; url: string }

/**
 * Where this site's notices go.
 *
 * Wave 11 changed the shape of this question. The global `REVALIDATE_WEBHOOK_URL`
 * was correct while there was at most one external renderer; with N deployed themes
 * it is wrong by construction — each deployment has its own origin *and* its own
 * signing secret, and one shared secret across twenty storefronts means any theme
 * author who reads their own environment can forge a cache purge at every other
 * customer on the fleet.
 *
 * So: the site's own live deployments contribute `https://<host>/api/revalidate`
 * keyed by that deployment's `ESHOBE_REVALIDATE_SECRET`, where `<host>` is the
 * application's own hostname (`applicationHostOf` — its preview name, because in
 * `edge` mode Caddy keeps the customer domain's `/api/*` on the CMS), and the env var stays as a
 * deployment-wide fallback for a renderer that is not managed here. Both, not either:
 * an operator running a separate static renderer alongside Coolify-hosted themes
 * needs both told.
 */
export const rendererEndpointsFor = async (
  req: PayloadRequest,
  siteId: string,
): Promise<RendererEndpoint[]> => {
  const endpoints: RendererEndpoint[] = []

  const globalUrl = process.env.REVALIDATE_WEBHOOK_URL
  const globalSecret = process.env.PAYLOAD_SECRET

  if (globalUrl && globalSecret) endpoints.push({ secret: globalSecret, url: globalUrl })

  try {
    const { docs } = await req.payload.find({
      collection: 'site-deployments',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ site: { equals: siteId } }, { status: { equals: 'live' } }] },
    })

    for (const row of docs as unknown as Record<string, unknown>[]) {
      const host = applicationHostOf(row)
      const secret = decryptDeploySecret(row.revalidateSecret as null | string)
      if (host && secret) endpoints.push({ secret, url: `https://${host}/api/revalidate` })
    }
  } catch (error) {
    // Best-effort, like everything else on this path. A publish must not fail
    // because the deployments table was briefly unreachable.
    req.payload.logger.warn({
      msg: `renderer targets unavailable: ${(error as Error)?.message ?? 'unknown'}`,
    })
  }

  return endpoints
}

/**
 * `sha256=<hex HMAC-SHA256(secret, body)>` — the v1 renderer signature.
 *
 * Exported so the contract is pinned by a test against independently computed bytes
 * (`tests/int/renderer-webhook.int.spec.ts`): the rest of the platform signs
 * `<timestamp>.<body>`, and this is the one place that must not be "fixed" to match.
 */
export const signRendererBody = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const post = (
  req: PayloadRequest,
  endpoint: RendererEndpoint,
  body: string,
  timestamp: string,
): void => {
  /**
   * The signature covers the raw body alone — **not** `<timestamp>.<body>`, which is
   * what `signWebhookPayload` in `src/lib/saas/crypto.ts` does for the platform
   * webhooks.
   *
   * The timestamp-prefixed form is the better scheme: a signature over the body alone
   * is replayable forever, while a signed timestamp lets a receiver reject a captured
   * delivery. It is not used here because this envelope is already published in
   * `docs/THEME_API.md` §17 as `HMAC-SHA256(secret, rawBody)`, and every theme
   * deployed against the v1 contract verifies it that way. Changing it would not fail
   * loudly; those renderers would simply reject every notice and quietly serve stale
   * pages forever.
   *
   * Replay is bounded instead by the payload: a notice only ever says "these paths
   * changed", so replaying one costs a redundant revalidation. Moving to the
   * timestamped form is a v2 contract change, made in `docs/THEME_API.md` first.
   *
   * `x-eshobe-timestamp` is still sent, unsigned, so a receiver can log or
   * rate-limit on it and so v2 has a header to start signing.
   */
  const signature = signRendererBody(endpoint.secret, body)

  void fetch(endpoint.url, {
    body,
    headers: {
      'content-type': 'application/json',
      'x-eshobe-signature': signature,
      'x-eshobe-timestamp': timestamp,
    },
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((response) => {
      if (!response.ok) {
        req.payload.logger.warn({
          msg: `renderer webhook: ${response.status} from ${endpoint.url}`,
        })
      }
    })
    .catch((error: unknown) => {
      req.payload.logger.warn({
        msg: `renderer webhook unreachable: ${(error as Error)?.message ?? 'unknown'}`,
      })
    })
}

export const notifyRenderers = ({
  paths,
  req,
  resources = [],
  siteId,
  tags = [],
}: RendererNotice & {
  req: PayloadRequest
}): void => {
  if (!paths.length && !resources.length && !tags.length) return

  const timestamp = new Date().toISOString()
  const body = JSON.stringify({ paths, resources, siteId, tags, timestamp })

  // Resolving the targets is a query, so this is async — but the caller is an
  // `afterChange` hook and must not wait for it, for exactly the reason the module
  // header gives. Fire the resolution and the deliveries together.
  void rendererEndpointsFor(req, siteId)
    .then((endpoints) => {
      if (!endpoints.length) return
      for (const endpoint of endpoints) post(req, endpoint, body, timestamp)
    })
    .catch(() => {
      /* already logged in `rendererEndpointsFor` */
    })
}
