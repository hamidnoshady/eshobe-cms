import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { issueBillingCredential, revokeBillingCredential } from '@/billing/auth/credentials'
import { isBillingScope, type BillingScope } from '@/billing/auth/sign'
import { verifyBillingRequest } from '@/billing/auth/verify-request'
import { parseUsageBatch, parseUsageEvent } from '@/billing/contract/v1'
import { parseProjectionInput, writeProjection } from '@/billing/entitlement/store'
import { billingIntegrationHealth, billingStatusForSite } from '@/billing/health'
import { commercialMigrationReport, seedProjectionsFromLegacy } from '@/billing/migration/report'
import { meterByKey } from '@/billing/meters/registry'
import { enqueueUsageEvent, replayOutboxEvent } from '@/billing/usage/outbox'
import { json, param, requireOperator, siteById } from '@/endpoints/platformShared'

/**
 * Execution-plane billing routes. They accept measurements and entitlement
 * projections. They do not create plans, prices, invoices or wallet movements.
 *
 * No Caddy carve-out: `/api/platform/*` stays on the control-plane host.
 */

const requireAdminSession = (req: PayloadRequest): null | Response => {
  if (isPlatformAdmin(req.user)) return null
  return json({ message: 'این عملیات فقط با نشست مدیر پلتفرم انجام می‌شود.', ok: false }, 403)
}

const noStore = (body: unknown, status = 200): Response => {
  const response = json(body, status)
  response.headers.set('cache-control', 'no-store')
  return response
}

export const billingHealthEndpoint: Endpoint = {
  path: '/platform/billing/health',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    return noStore({ health: await billingIntegrationHealth(req), ok: true })
  },
}

export const billingCredentialIssueEndpoint: Endpoint = {
  path: '/platform/billing/credentials',
  method: 'post',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied
    const body = (await req.json?.().catch(() => ({}))) as { label?: unknown; scopes?: unknown }
    const requested = (Array.isArray(body.scopes) ? body.scopes.filter(isBillingScope) : ['billing.entitlement.write']) as BillingScope[]
    if (requested.includes('billing.usage.write')) {
      return json(
        {
          message: 'کلید billing.usage.write روی سکوی مرکزی صادر می‌شود و در CMS فقط ذخیره می‌شود.',
          ok: false,
        },
        400,
      )
    }
    const scopes: BillingScope[] = requested.length ? requested : ['billing.entitlement.write']
    if (scopes.length === 0) return json({ message: 'دامنهٔ کلید نامعتبر است.', ok: false }, 400)
    const issued = await issueBillingCredential(req, {
      label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'billing',
      scopes,
    })
    return noStore({ keyId: issued.keyId, ok: true, scopes: issued.scopes, secret: issued.secret }, 201)
  },
}

export const billingCredentialRevokeEndpoint: Endpoint = {
  path: '/platform/billing/credentials/:keyId/revoke',
  method: 'post',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied
    const keyId = param(req, 'keyId')
    const revoked = await revokeBillingCredential(req, keyId)
    if (!revoked) return json({ message: 'کلید پیدا نشد.', ok: false }, 404)
    return noStore({ ok: true, revoked: keyId })
  },
}

export const entitlementPushEndpoint: Endpoint = {
  path: '/platform/billing/entitlements/v1',
  method: 'post',
  handler: async (req) => {
    const verified = await verifyBillingRequest(req, 'billing.entitlement.write')
    if (!verified.ok) return verified.error
    const parsed = parseProjectionInput(verified.call.parsed, 'push')
    if ('error' in parsed) return json({ message: parsed.error, ok: false }, 400)
    const written = await writeProjection(req, parsed.input)
    if (!written.ok) return json({ message: written.message, ok: false }, written.status)
    return noStore({ ok: true, result: written.result, version: written.version })
  },
}

export const usageIngestEndpoint: Endpoint = {
  path: '/platform/billing/usage/v1',
  method: 'post',
  handler: async (req) => {
    const verified = await verifyBillingRequest(req, 'billing.usage.write')
    if (!verified.ok) return verified.error
    const body = verified.call.parsed
    const events =
      body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events)
        ? parseUsageBatch({ ...(body as object), contractVersion: 1, source: 'eshobe-cms' })
        : null
    if (events && 'error' in events) return json({ message: events.error.message, ok: false }, 400)
    const list = events && 'batch' in events ? events.batch.events : []
    if (!events) {
      const one = parseUsageEvent(body)
      if ('error' in one) return json({ message: one.error.message, ok: false }, 400)
      const meter = meterByKey(one.event.meterKey)
      if (meter.collection !== 'ingest') {
        return json({ message: 'این سنجه را فقط جمع‌کنندهٔ داخلی ثبت می‌کند.', ok: false }, 400)
      }
      const queued = await enqueueUsageEvent(req, one.event)
      return noStore({ ok: true, results: [queued] })
    }
    const results = []
    for (const event of list) {
      const meter = meterByKey(event.meterKey)
      if (meter.collection !== 'ingest') {
        return json({ message: `سنجهٔ ${event.meterKey} از مسیر خارجی پذیرفته نمی‌شود.`, ok: false }, 400)
      }
      results.push(await enqueueUsageEvent(req, event))
    }
    return noStore({ ok: true, results })
  },
}

export const outboxReplayEndpoint: Endpoint = {
  path: '/platform/billing/outbox/:eventId/replay',
  method: 'post',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied
    const eventId = decodeURIComponent(param(req, 'eventId'))
    const result = await replayOutboxEvent(req, eventId)
    if (!result.ok) return json({ message: 'رویداد پیدا نشد.', ok: false }, 404)
    return noStore({ ok: true, status: result.status })
  },
}

export const migrationReportEndpoint: Endpoint = {
  path: '/platform/billing/migration',
  method: 'get',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied
    return noStore({ ok: true, report: await commercialMigrationReport(req) })
  },
}

export const migrationSeedEndpoint: Endpoint = {
  path: '/platform/billing/migration/seed',
  method: 'post',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied
    try {
      const seeded = await seedProjectionsFromLegacy(req)
      return noStore({ ok: true, ...seeded })
    } catch (error) {
      return json({ message: (error as Error).message, ok: false }, 409)
    }
  },
}

export const siteBillingEndpoint: Endpoint = {
  path: '/platform/sites/:id/billing',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)
    return noStore({ billing: await billingStatusForSite(req, String(site.id)), ok: true })
  },
}

export const platformBillingEndpoints: Endpoint[] = [
  billingHealthEndpoint,
  billingCredentialIssueEndpoint,
  billingCredentialRevokeEndpoint,
  entitlementPushEndpoint,
  usageIngestEndpoint,
  outboxReplayEndpoint,
  migrationReportEndpoint,
  migrationSeedEndpoint,
  siteBillingEndpoint,
]
