import type { Endpoint, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import type { PlatformEventPayload } from '@/lib/saas/events'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isUuid } from '@/lib/ids'
import { generateWebhookSecret, encryptPlatformSecret, fingerprintPlatformSecret } from '@/lib/saas/crypto'
import { readPlatformSecret } from '@/collections/hooks/platformSecrets'
import { deliverOnce, recordDelivery } from '@/platform/webhooks'
import { recordAudit } from '@/platform/audit'

import { json, requireOperator } from './platformShared'

/**
 * The webhook lifecycle routes.
 *
 * **Collection endpoints, not top-level ones.** Payload dispatches `/api/<first-segment>/…`
 * against the collection whose slug matches the first segment and never falls back
 * to `config.endpoints` — so a top-level `/webhooks/test` would answer 404 forever
 * while an int test that imports the handler directly stayed green. `/api-keys/issue`
 * and `/storage-connections/self-test` both shipped that bug once; CLAUDE.md records
 * the rule and `Webhooks.endpoints` is where these are registered.
 */

const readBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  try {
    return ((await req.json?.()) ?? {}) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * `POST /api/webhooks/test` — send a signed `platform.settingsChanged` ping.
 *
 * Not a dry run: it really delivers, with a real signature, to the real URL. A test
 * that only checks the URL parses proves nothing about the one thing that actually
 * breaks — whether the receiver verifies the signature the way this platform
 * computes it.
 */
export const webhookTestEndpoint: Endpoint = {
  path: '/test',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const input = await readBody(req)
    const id = String(input.id ?? '')
    if (!isUuid(id)) return json({ message: 'شناسهٔ وب‌هوک معتبر نیست.', ok: false }, 400)

    const webhook = await req.payload.findByID({
      id,
      collection: 'webhooks',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })

    if (!webhook) return json({ message: 'وب‌هوک پیدا نشد.', ok: false }, 404)

    const secret = await readPlatformSecret(req, 'webhooks', id, 'secret')
    if (!secret) {
      return json(
        { message: 'کلید امضا قابل خواندن نیست — احتمالاً PLATFORM_SECRET_KEY تغییر کرده. کلید تازه بسازید.', ok: false },
        409,
      )
    }

    const settings = await req.payload
      .findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req })
      .catch(() => null)

    const body: PlatformEventPayload = {
      actor: req.user
        ? {
            email: String((req.user as { email?: unknown }).email ?? ''),
            id: String((req.user as { id?: unknown }).id ?? ''),
            type: 'user',
          }
        : { type: 'system' },
      at: new Date().toISOString(),
      data: { test: true },
      event: 'platform.settingsChanged',
      id: randomUUID(),
      message: 'این یک ارسال آزمایشی از سکو است.',
      site: null,
    }

    const outcome = await deliverOnce({
      body,
      secret,
      timeoutMs: Number((settings as { webhookTimeoutMs?: unknown } | null)?.webhookTimeoutMs ?? 5000) || 5000,
      url: String(webhook.url ?? ''),
    })

    /**
     * Recorded and counted through the same path a platform-initiated delivery takes.
     *
     * A test is not a simulation — it is a real signed POST to the customer's real
     * URL, so the delivery log must show it and the health counters must move with
     * it. The alternative that was here first (clear the counter on success, ignore a
     * failure, write no row) made an endpoint's health improvable by hand only, and
     * left the operator's replay screen empty for the request they had just watched
     * fail.
     *
     * A real event id rather than `test-<timestamp>`: this row is replayable like any
     * other, and a receiver deduplicating on `id` should see the same shape it always
     * does.
     */
    await recordDelivery(req, {
      attempt: 1,
      body,
      maxFailures: Number((settings as { webhookMaxFailures?: unknown } | null)?.webhookMaxFailures ?? 10) || 10,
      outcome,
      webhook: webhook as unknown as Record<string, unknown>,
    })

    return json({
      detail: outcome.error,
      durationMs: outcome.durationMs,
      ok: outcome.ok,
      statusCode: outcome.statusCode,
    })
  },
}

/**
 * `POST /api/webhooks/rotate-secret` — mint a new signing secret and return it once.
 *
 * The only moment a webhook secret is readable. The same rule as an API key: the
 * value exists in exactly one response and nowhere else, because a secret a console
 * can fetch twice is a secret with two chances to leak. Rotating immediately
 * invalidates the old one — the receiver must be updated in the same window, which
 * the response says.
 */
export const webhookRotateSecretEndpoint: Endpoint = {
  path: '/rotate-secret',
  method: 'post',
  handler: async (req) => {
    // Session only. A rotation breaks a live integration until the receiver is
    // updated, so it stays a deliberate human action — the same line
    // `payments/cancel` draws.
    if (!isPlatformAdmin(req.user)) {
      return json({ message: 'چرخش کلید فقط با نشست مدیر پلتفرم انجام می‌شود.', ok: false }, 403)
    }

    const body = await readBody(req)
    const id = String(body.id ?? '')
    if (!isUuid(id)) return json({ message: 'شناسهٔ وب‌هوک معتبر نیست.', ok: false }, 400)

    const webhook = await req.payload.findByID({
      id,
      collection: 'webhooks',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })
    if (!webhook) return json({ message: 'وب‌هوک پیدا نشد.', ok: false }, 404)

    const raw = generateWebhookSecret()

    await req.payload.update({
      id,
      collection: 'webhooks',
      data: {
        secret: encryptPlatformSecret(raw),
        secretSummary: `کلید امضا فعال · ${fingerprintPlatformSecret(raw)}`,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })

    await recordAudit(req, {
      action: 'platform.settingsChanged',
      summary: `کلید امضای وب‌هوک «${webhook.name}» چرخانده شد.`,
      targetCollection: 'webhooks',
      targetId: id,
    })

    return json({
      message: 'این کلید فقط همین یک بار نمایش داده می‌شود. گیرنده را همین حالا به‌روز کنید؛ کلید قبلی باطل شد.',
      ok: true,
      secret: raw,
    })
  },
}

/**
 * `POST /api/webhooks/replay` — resend a recorded delivery, byte for byte.
 *
 * The body is the one that was stored, not a regenerated one: replaying a
 * *reconstructed* event would send something that never happened, with a fresh
 * timestamp, and the receiver would have no way to recognise it as the delivery it
 * missed.
 */
export const webhookReplayEndpoint: Endpoint = {
  path: '/replay',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const body = await readBody(req)
    const deliveryId = String(body.deliveryId ?? '')
    if (!isUuid(deliveryId)) return json({ message: 'شناسهٔ ارسال معتبر نیست.', ok: false }, 400)

    const delivery = await req.payload.findByID({
      id: deliveryId,
      collection: 'webhook-deliveries',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })

    if (!delivery) return json({ message: 'ارسال پیدا نشد.', ok: false }, 404)

    const webhookId = String((delivery as { webhook?: unknown }).webhook ?? '')
    if (!isUuid(webhookId)) return json({ message: 'وب‌هوک این ارسال دیگر وجود ندارد.', ok: false }, 409)

    const webhook = await req.payload.findByID({
      id: webhookId,
      collection: 'webhooks',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })
    if (!webhook) return json({ message: 'وب‌هوک پیدا نشد.', ok: false }, 404)

    const secret = await readPlatformSecret(req, 'webhooks', webhookId, 'secret')
    if (!secret) return json({ message: 'کلید امضا قابل خواندن نیست.', ok: false }, 409)

    const settings = await req.payload
      .findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req })
      .catch(() => null)

    // The stored payload, cast rather than rebuilt: the point of a replay is that
    // these are the exact bytes the receiver missed.
    const storedBody = (delivery as { requestBody?: unknown }).requestBody as PlatformEventPayload

    const outcome = await deliverOnce({
      body: storedBody,
      secret,
      timeoutMs: Number((settings as { webhookTimeoutMs?: unknown } | null)?.webhookTimeoutMs ?? 5000) || 5000,
      url: String(webhook.url ?? ''),
    })

    await req.payload
      .create({
        collection: 'webhook-deliveries',
        data: {
          attempt: Number((delivery as { attempt?: unknown }).attempt ?? 1) + 1,
          durationMs: outcome.durationMs,
          error: outcome.error,
          event: (delivery as { event?: unknown }).event as never,
          ok: outcome.ok,
          requestBody: storedBody as unknown as Record<string, unknown>,
          responseBody: outcome.responseBody,
          statusCode: outcome.statusCode,
          webhook: webhookId,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      .catch(() => undefined)

    return json({ detail: outcome.error, ok: outcome.ok, statusCode: outcome.statusCode })
  },
}

export const webhookEndpoints: Endpoint[] = [
  webhookTestEndpoint,
  webhookRotateSecretEndpoint,
  webhookReplayEndpoint,
]
