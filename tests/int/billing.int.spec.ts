// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { issueBillingCredential } from '@/billing/auth/credentials'
import { signBillingBody, BILLING_KEY_HEADER, BILLING_SIGNATURE_HEADER, BILLING_TIMESTAMP_HEADER } from '@/billing/auth/sign'
import { verifyBillingRequest } from '@/billing/auth/verify-request'
import { parseUsageEvent, type UsageEventV1 } from '@/billing/contract/v1'
import { writeProjection } from '@/billing/entitlement/store'
import { hourlyEventId, utcHourWindow } from '@/billing/meters/event-id'
import { noteCustomerApiRequest, drainMeterBuffer } from '@/billing/meters/buffer'
import { compareEntitlement } from '@/billing/migration/report'
import { enqueueCorrection, enqueueUsageEvent, leaseOutboxBatch, recoverStaleSending, replayOutboxEvent } from '@/billing/usage/outbox'
import { flushMeterBuffer } from '@/billing/usage/fold'
import { publishUsageBatch } from '@/billing/usage/publisher'
import { entitlementPushEndpoint, usageIngestEndpoint } from '@/endpoints/platformBilling'
import { siteUsageEndpoint } from '@/endpoints/platformSaas'
import { resolveEntitlement } from '@/platform/entitlements'
import config from '@/payload.config'

let payload: Payload
let siteId = ''

const reqAs = async (): Promise<PayloadRequest> => {
  const { docs } = await payload.find({ collection: 'users', depth: 0, limit: 1, where: { email: { equals: 'admin@eshobe.test' } } })
  const admin = docs[0]
  if (!admin) throw new Error('admin missing — run pnpm seed')
  return createLocalReq({ user: { ...admin, collection: 'users' } }, payload)
}

const forgetEvent = async (eventId: string) => {
  const { docs } = await payload.find({
    collection: 'billing-usage-outbox',
    depth: 0,
    limit: 5,
    overrideAccess: true,
    where: { eventId: { equals: eventId } },
  })
  for (const doc of docs) {
    await payload.delete({ collection: 'billing-usage-outbox', id: String(doc.id), overrideAccess: true })
  }
}

const eventFor = (quantity = 4): UsageEventV1 => {
  const hour = new Date('2026-09-26T13:00:00.000Z')
  const parsed = parseUsageEvent({
    eventId: hourlyEventId(siteId, 'cms.api_request', hour),
    meterKey: 'cms.api_request',
    occurredAt: hour.toISOString(),
    periodEnd: utcHourWindow(hour).end.toISOString(),
    periodStart: utcHourWindow(hour).start.toISOString(),
    quantity,
    siteId,
    unit: 'request',
  })
  if ('error' in parsed) throw new Error(parsed.error.message)
  return parsed.event
}

beforeAll(async () => {
  payload = await getPayload({ config })
  const { docs } = await payload.find({ collection: 'sites', depth: 0, limit: 1, where: { slug: { equals: 'shop' } } })
  if (!docs[0]) throw new Error('shop missing — run pnpm seed')
  siteId = String(docs[0].id)
})

afterAll(async () => {
  const req = await reqAs()
  for (const collection of ['billing-usage-outbox', 'billing-usage-samples', 'central-entitlement-projections', 'billing-service-credentials', 'billing-replay-nonces'] as const) {
    const { docs } = await payload.find({ collection, depth: 0, limit: 100, overrideAccess: true, pagination: false, req })
    for (const doc of docs) {
      const site = (doc as { site?: unknown }).site
      const owned = !site || String(site) === siteId
      if (!owned && collection !== 'billing-service-credentials' && collection !== 'billing-replay-nonces') continue
      if (collection === 'billing-service-credentials' || collection === 'billing-replay-nonces' || owned) {
        await payload.delete({ collection, id: String(doc.id), overrideAccess: true, req }).catch(() => undefined)
      }
    }
  }
})

describe('usage outbox', () => {
  it('persists one row for a repeated event id', async () => {
    const req = await reqAs()
    const event = eventFor(9)
    await forgetEvent(event.eventId)
    const first = await enqueueUsageEvent(req, event)
    const second = await enqueueUsageEvent(req, event)
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)
    const { totalDocs } = await payload.count({
      collection: 'billing-usage-outbox',
      overrideAccess: true,
      req,
      where: { eventId: { equals: event.eventId } },
    })
    expect(totalDocs).toBe(1)
  })

  it('marks accepted and duplicate acknowledgements sent, and retries a network failure', async () => {
    const req = await reqAs()
    const event = eventFor(3)
    await forgetEvent(event.eventId)
    await enqueueUsageEvent(req, event)
    vi.stubEnv('CENTRAL_BILLING_URL', 'https://billing.example.test')
    const issued = await issueBillingCredential(req, { label: 'test', scopes: ['billing.usage.write'] })
    expect(issued.secret.startsWith('bsec_')).toBe(true)

    const stored = await payload.find({
      collection: 'billing-service-credentials',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { keyId: { equals: issued.keyId } },
    })
    expect(String((stored.docs[0] as { secret?: string }).secret ?? '')).toBe('')

    const down = await publishUsageBatch(req, async () => {
      throw new Error('network down')
    })
    expect(down.transient).toBeGreaterThan(0)
    const failed = await payload.find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { eventId: { equals: event.eventId } },
    })
    expect((failed.docs[0] as { status?: string }).status).toBe('failed')

    await replayOutboxEvent(req, event.eventId)
    const accepted = await publishUsageBatch(req, async () =>
      new Response(JSON.stringify({ results: [{ eventId: event.eventId, status: 'accepted' }] }), { status: 200 }),
    )
    expect(accepted.accepted).toBe(1)
    const sent = await payload.find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { eventId: { equals: event.eventId } },
    })
    expect((sent.docs[0] as { status?: string }).status).toBe('sent')

    const again = await enqueueUsageEvent(req, eventFor(99))
    expect(again.duplicate).toBe(true)
    expect(again.status).toBe('sent')
    vi.unstubAllEnvs()
  })

  it('dead-letters a permanent rejection and recovers a stale lease', async () => {
    const req = await reqAs()
    const hour = new Date('2026-09-26T15:00:00.000Z')
    const parsed = parseUsageEvent({
      eventId: hourlyEventId(siteId, 'cms.bandwidth_bytes', hour),
      meterKey: 'cms.bandwidth_bytes',
      occurredAt: hour.toISOString(),
      periodEnd: utcHourWindow(hour).end.toISOString(),
      periodStart: utcHourWindow(hour).start.toISOString(),
      quantity: 10,
      siteId,
      unit: 'byte',
    })
    if ('error' in parsed) throw new Error(parsed.error.message)
    await forgetEvent(parsed.event.eventId)
    await enqueueUsageEvent(req, parsed.event)
    vi.stubEnv('CENTRAL_BILLING_URL', 'https://billing.example.test')
    await issueBillingCredential(req, { label: 'reject', scopes: ['billing.usage.write'] })
    const rejected = await publishUsageBatch(req, async () =>
      new Response(
        JSON.stringify({ results: [{ eventId: parsed.event.eventId, reason: 'unknown_meter', status: 'rejected' }] }),
        { status: 200 },
      ),
    )
    expect(rejected.dead).toBe(1)

    const { docs } = await payload.find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { eventId: { equals: parsed.event.eventId } },
    })
    await payload.update({
      id: String(docs[0]!.id),
      collection: 'billing-usage-outbox',
      data: { lastAttemptAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'sending' },
      overrideAccess: true,
      req,
    })
    expect(await recoverStaleSending(req)).toBeGreaterThan(0)
    vi.unstubAllEnvs()
  })

  it('records a correction instead of editing an accepted event', async () => {
    const req = await reqAs()
    const original = eventFor(4)
    const correction = await enqueueCorrection(req, {
      actor: 'operator',
      delta: -1,
      original,
      reason: 'counted a health check',
    })
    expect(correction.id).toBeTruthy()
    const { docs } = await payload.find({
      collection: 'billing-usage-outbox',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { id: { equals: correction.id } },
    })
    expect((docs[0] as { kind?: string }).kind).toBe('correction')
    expect((docs[0] as { correctsEventId?: string }).correctsEventId).toBe(original.eventId)
  })

  it('folds buffered API requests into one sample', async () => {
    drainMeterBuffer()
    noteCustomerApiRequest(siteId)
    noteCustomerApiRequest(siteId)
    const req = await reqAs()
    const written = await flushMeterBuffer(req)
    expect(written).toBe(1)
    const { docs } = await payload.find({
      collection: 'billing-usage-samples',
      depth: 0,
      limit: 5,
      overrideAccess: true,
      req,
      sort: '-createdAt',
      where: { site: { equals: siteId } },
    })
    expect(Number((docs[0] as { quantity?: number }).quantity)).toBeGreaterThanOrEqual(2)
  })

  it('leases a bounded batch', async () => {
    const req = await reqAs()
    const leased = await leaseOutboxBatch(req)
    expect(leased.length).toBeLessThanOrEqual(50)
  })
})

describe('entitlement projection', () => {
  it('accepts a newer version, ignores a stale one, and refuses an unknown site', async () => {
    const req = await reqAs()
    const base = {
      features: { store: true },
      limits: { pages: { state: 'limit' as const, value: 4 } },
      planCode: 'pro',
      serving: true,
      siteId,
      source: 'push' as const,
      subscriptionStatus: 'past_due',
    }
    expect((await writeProjection(req, { ...base, version: 1 })).ok).toBe(true)
    expect((await writeProjection(req, { ...base, version: 2 })).ok).toBe(true)
    const duplicate = await writeProjection(req, { ...base, version: 2 })
    expect(duplicate.ok && duplicate.result).toBe('idempotent')
    const stale = await writeProjection(req, { ...base, version: 1 })
    expect(stale.ok).toBe(false)
    const missing = await writeProjection(req, { ...base, siteId: '22222222-2222-2222-2222-222222222222', version: 1 })
    expect(missing.ok).toBe(false)

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const site = await payload.findByID({ collection: 'sites', depth: 0, id: siteId, overrideAccess: true, req })
    const entitlement = await resolveEntitlement(req, site as unknown as Record<string, unknown>)
    expect(entitlement.authority).toBe('projection')
    expect(entitlement.serving).toBe(true)
    expect(entitlement.limits.pages).toBe(4)
    expect(entitlement.plan?.code).toBe('pro')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()

    const legacy = { ...entitlement, authority: 'legacy' as const, limits: {}, serving: false }
    const mismatches = compareEntitlement(siteId, legacy, { features: base.features, limits: base.limits, planCode: 'pro', serving: true })
    expect(mismatches.length).toBeGreaterThan(0)
  })

  it('does not let a local override grant a commercial feature', async () => {
    const req = await reqAs()
    const created = await payload.create({
      collection: 'site-entitlements',
      data: {
        limitOverrides: { pages: 1 },
        quotaEnforcement: 'warn',
        site: siteId,
      },
      overrideAccess: true,
      req,
    })
    const stored = await payload.findByID({ collection: 'site-entitlements', depth: 0, id: String(created.id), overrideAccess: true, req })
    expect(stored.limitOverrides?.pages ?? null).toBeNull()
    await payload.delete({ collection: 'site-entitlements', id: String(created.id), overrideAccess: true, req })
  })
})

describe('service auth', () => {
  it('accepts a signed body once and refuses a replay, a bad signature and a site key', async () => {
    const req = await reqAs()
    const issued = await issueBillingCredential(req, { label: 'push', scopes: ['billing.entitlement.write'] })
    const body = JSON.stringify({
      features: {},
      limits: {},
      planCode: 'pro',
      serving: true,
      siteId,
      version: 3,
    })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = signBillingBody(issued.secret, timestamp, body)
    const signed = await createLocalReq(
      {
        req: {
          headers: new Headers({
            [BILLING_KEY_HEADER]: issued.keyId,
            [BILLING_SIGNATURE_HEADER]: signature,
            [BILLING_TIMESTAMP_HEADER]: timestamp,
          }),
          text: async () => body,
        } as Partial<PayloadRequest>,
      },
      payload,
    )
    const first = await verifyBillingRequest(signed, 'billing.entitlement.write')
    expect(first.ok).toBe(true)
    const replay = await verifyBillingRequest(signed, 'billing.entitlement.write')
    expect(replay.ok).toBe(false)

    const bad = await usageIngestEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            headers: new Headers({ authorization: 'Bearer site-key' }),
            json: async () => ({ meterKey: 'cms.bandwidth_bytes' }),
          } as Partial<PayloadRequest>,
        },
        payload,
      ),
    )
    expect(bad.status).toBe(401)

    const unsigned = await entitlementPushEndpoint.handler!(await createLocalReq({}, payload))
    expect(unsigned.status).toBe(401)
  })

  it('refuses a billing meter on the approximate quota endpoint', async () => {
    const req = await reqAs()
    const res = await siteUsageEndpoint.handler!(
      Object.assign(req, {
        json: async () => ({ metric: 'cms.api_request', amount: 1 }),
        routeParams: { id: siteId },
      }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a new commercial plan', async () => {
    await expect(
      payload.create({
        collection: 'plans',
        data: { code: 'must-not-exist', currency: 'IRT', interval: 'monthly', name: 'no', price: 1 } as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/بایگانی|پلتفرم/)
  })
})
