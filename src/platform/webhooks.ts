import type { PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { readPlatformSecret } from '@/collections/hooks/platformSecrets'
import { idOf } from '@/lib/ids'
import { signWebhookPayload } from '@/lib/saas/crypto'
import {
  eventLevel,
  PLATFORM_EVENTS,
  type PlatformEventName,
  type PlatformEventPayload,
} from '@/lib/saas/events'
import { recordAudit } from './audit'

/**
 * Outbound event delivery.
 *
 * ## The one rule
 *
 * **Nothing waits for a receiver.** `emitPlatformEvent` writes the audit row,
 * returns, and dispatches in the background — the same `void` + log shape
 * `src/lib/renderer-webhook.ts` and the buyer-email path already use, and for the
 * same reason stated in CLAUDE.md: a paid order, a provisioned site or a suspension
 * must not fail because somebody's Slack relay is down. The cost is at-most-once
 * delivery, which is why every delivery is recorded and why `POST
 * /api/platform/deliveries/:id/replay` exists.
 *
 * ## Why there is no retry loop here
 *
 * A retry that lives inside the request that triggered it is not a retry, it is a
 * slower request. Real redelivery belongs in the jobs queue, and this deployment's
 * queue runs in-process on a one-minute cron (`payload.config`'s `jobs.autoRun`) —
 * so the honest design today is: attempt once, record the outcome, and let an
 * operator replay. `consecutiveFailures` disabling a dead endpoint is what stops a
 * broken receiver from being retried by hand forever.
 */

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_RESPONSE_CHARS = 1_000

type DeliveryOutcome = {
  durationMs: number
  error: null | string
  ok: boolean
  responseBody: null | string
  statusCode: null | number
}

const settings = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  try {
    return (await req.payload.findGlobal({
      slug: 'platform-settings',
      depth: 0,
      overrideAccess: true,
      req,
    })) as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * One POST, with a hard timeout.
 *
 * `AbortController` rather than a promise race: a race leaves the socket open and
 * the process holding it, which on a dead receiver means one leaked connection per
 * event until the pool is gone.
 */
export const deliverOnce = async (args: {
  body: PlatformEventPayload
  secret: string
  timeoutMs: number
  url: string
}): Promise<DeliveryOutcome> => {
  const started = Date.now()
  const payload = JSON.stringify(args.body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs)

  try {
    const response = await fetch(args.url, {
      body: payload,
      headers: {
        'content-type': 'application/json',
        // The three headers a receiver needs to verify without guessing the scheme.
        'x-eshobe-event': args.body.event,
        'x-eshobe-signature': signWebhookPayload(args.secret, timestamp, payload),
        'x-eshobe-timestamp': timestamp,
        'user-agent': 'eshobe-cms-webhooks/1',
      },
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
    })

    const text = await response.text().catch(() => '')

    return {
      durationMs: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
      ok: response.ok,
      // Truncated on purpose: a receiver's error page can contain its own secrets,
      // and a log that mirrors it wholesale makes that this database's problem.
      responseBody: text ? text.slice(0, MAX_RESPONSE_CHARS) : null,
      statusCode: response.status,
    }
  } catch (error) {
    const aborted = (error as Error)?.name === 'AbortError'
    return {
      durationMs: Date.now() - started,
      error: aborted ? `تایم‌اوت پس از ${args.timeoutMs} میلی‌ثانیه` : String((error as Error)?.message ?? error).slice(0, 500),
      ok: false,
      responseBody: null,
      statusCode: null,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Record the attempt and move the endpoint's health counters.
 *
 * Exported because `POST /api/webhooks/test` sends a *real* signed request to the
 * customer's *real* URL, and must therefore be recorded and counted exactly like a
 * delivery the platform initiated. When it was not, two things were quietly wrong:
 * the delivery log claimed nothing had been sent to an endpoint the operator had
 * just pinged, and a failing test cleared nothing while a succeeding one reset the
 * counter — so an endpoint's health could only ever improve by hand.
 */
export const recordDelivery = async (
  req: PayloadRequest,
  args: {
    attempt: number
    body: PlatformEventPayload
    maxFailures: number
    outcome: DeliveryOutcome
    webhook: Record<string, unknown>
  },
): Promise<void> => {
  const { attempt, body, maxFailures, outcome, webhook } = args

  try {
    await req.payload.create({
      collection: 'webhook-deliveries',
      data: {
        attempt,
        durationMs: outcome.durationMs,
        error: outcome.error,
        event: body.event,
        ok: outcome.ok,
        requestBody: body as unknown as Record<string, unknown>,
        responseBody: outcome.responseBody,
        statusCode: outcome.statusCode,
        webhook: String(webhook.id),
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'webhook delivery log failed' })
  }

  const failures = outcome.ok ? 0 : Number(webhook.consecutiveFailures ?? 0) + 1
  const disable = !outcome.ok && failures >= maxFailures

  try {
    await req.payload.update({
      id: String(webhook.id),
      collection: 'webhooks',
      data: {
        consecutiveFailures: failures,
        lastDeliveryAt: new Date().toISOString(),
        lastDeliveryOk: outcome.ok,
        lastError: outcome.error,
        ...(disable ? { enabled: false } : {}),
      },
      depth: 0,
      overrideAccess: true,
      req,
    })

    if (disable) {
      req.payload.logger.warn(
        `webhook ${webhook.id} disabled after ${failures} consecutive failures`,
      )
    }
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'webhook health update failed' })
  }
}

/** Every enabled webhook subscribed to this event, narrowed by site when the row names one. */
const subscribersFor = async (
  req: PayloadRequest,
  event: PlatformEventName,
  siteId: null | string,
): Promise<Record<string, unknown>[]> => {
  const { docs } = await req.payload.find({
    collection: 'webhooks',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        { enabled: { equals: true } },
        { events: { contains: event } },
        // A row with no site hears everything; a row naming a site hears only that
        // site's events *and* no platform-level ones, which is what "فقط برای سایت"
        // says on the form.
        siteId ? { or: [{ site: { exists: false } }, { site: { equals: siteId } }] } : { site: { exists: false } },
      ],
    },
  })

  return docs as unknown as Record<string, unknown>[]
}

export const dispatchEvent = async (
  req: PayloadRequest,
  body: PlatformEventPayload,
): Promise<{ attempted: number; delivered: number }> => {
  const config = await settings(req)
  const timeoutMs = Number(config.webhookTimeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const maxFailures = Number(config.webhookMaxFailures ?? 10) || 10

  const webhooks = await subscribersFor(req, body.event, body.site?.id ?? null)
  let delivered = 0

  for (const webhook of webhooks) {
    const secret = await readPlatformSecret(req, 'webhooks', String(webhook.id), 'secret')
    if (!secret) {
      req.payload.logger.error(`webhook ${webhook.id} has no usable signing secret; skipped`)
      continue
    }

    const outcome = await deliverOnce({
      body,
      secret,
      timeoutMs,
      url: String(webhook.url ?? ''),
    })

    if (outcome.ok) delivered += 1
    await recordDelivery(req, { attempt: 1, body, maxFailures, outcome, webhook })
  }

  return { attempted: webhooks.length, delivered }
}

export type EmitInput = {
  audit?: boolean
  data?: Record<string, unknown>
  event: PlatformEventName
  message?: string
  site?: null | string | { domain?: unknown; id?: unknown }
  targetCollection?: null | string
  targetId?: null | string
}

/**
 * The one call a mutation makes: record it, tell everybody who is listening, and
 * return immediately.
 *
 * The audit row is awaited (it is a local insert and the trail is the point), the
 * HTTP fan-out is not (`void` + log). Getting that split backwards is how a
 * provisioning request starts taking eleven seconds because a customer's endpoint
 * is slow.
 */
export const emitPlatformEvent = async (req: PayloadRequest, input: EmitInput): Promise<PlatformEventPayload> => {
  const siteId = idOf(input.site)
  const siteDomain =
    input.site && typeof input.site === 'object'
      ? String((input.site as { domain?: unknown }).domain ?? '') || null
      : null

  const body: PlatformEventPayload = {
    actor: req.user
      ? { email: String((req.user as { email?: unknown }).email ?? ''), id: String((req.user as { id?: unknown }).id ?? ''), type: 'user' }
      : { type: 'system' },
    at: new Date().toISOString(),
    data: input.data ?? {},
    event: input.event,
    id: randomUUID(),
    message: input.message ?? PLATFORM_EVENTS[input.event],
    site: siteId ? { domain: siteDomain, id: siteId } : null,
  }

  if (input.audit !== false) {
    await recordAudit(req, {
      action: input.event,
      changes: input.data ?? null,
      site: siteId,
      summary: body.message,
      targetCollection: input.targetCollection ?? null,
      targetId: input.targetId ?? null,
    })
  }

  void dispatchEvent(req, body).catch((error) =>
    req.payload.logger.error({ err: error as Error, msg: `webhook dispatch failed for ${input.event}` }),
  )

  return body
}

/** Severity, re-exported so a console does not re-derive it. */
export { eventLevel }
