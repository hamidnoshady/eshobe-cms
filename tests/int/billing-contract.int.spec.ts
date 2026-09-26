import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  signLegacyUsageBody,
  verifyLegacyUsageSignature,
} from '@/billing/auth/compat/legacy-nonce-body-hash'
import { parseUsageBatch, parseUsageEvent } from '@/billing/contract/v1'
import { parseProjectionInput } from '@/billing/entitlement/store'
import { applyTechnicalGate } from '@/billing/entitlement/features'
import { decideProjectionVersion, limitsToQuota, parseLimitMap } from '@/billing/entitlement/limits'
import { parseBatchAck } from '@/billing/client/interpret'
import { centralBillingUrl } from '@/billing/client/url'
import { isBillableCustomerApiPath } from '@/billing/meters/api-path'
import { deploymentMeasure } from '@/billing/meters/deployment'
import { correctionEventId, deploymentEventId, hourlyEventId, utcHourWindow } from '@/billing/meters/event-id'
import { isBillingMeterKey } from '@/billing/meters/registry'
import { advanceStorageClock, emptyStorageClock } from '@/billing/meters/storage-integral'
import { verifyBillingSignature, signBillingBody, REPLAY_WINDOW_MS } from '@/billing/auth/sign'
import { OUTBOX_BATCH } from '@/billing/usage/outbox'
import { MAX_PUBLISH_ATTEMPTS, classifyPublishResult, nextAttemptDelayMs } from '@/billing/usage/retry'

const contractRoot = join(dirname(fileURLToPath(import.meta.url)), '../../billing-contract/v1')
const readFixture = (name: string) => JSON.parse(readFileSync(join(contractRoot, 'fixtures', name), 'utf8'))
const readVectors = () =>
  JSON.parse(readFileSync(join(contractRoot, 'hmac-test-vectors.json'), 'utf8')) as {
    vectors: { body: string; id: string; secret: string; signature: string; timestampSec: string }[]
  }

const site = '11111111-1111-1111-1111-111111111111'
const hour = new Date('2026-09-26T13:00:00.000Z')

const measurement = (overrides: Record<string, unknown> = {}) => ({
  eventId: hourlyEventId(site, 'cms.api_request', hour),
  meterKey: 'cms.api_request',
  occurredAt: hour.toISOString(),
  periodEnd: utcHourWindow(hour).end.toISOString(),
  periodStart: utcHourWindow(hour).start.toISOString(),
  quantity: 18,
  siteId: site,
  unit: 'request',
  ...overrides,
})

describe('billing contract v1', () => {
  it('accepts a known meter and rejects an unknown one', () => {
    expect(isBillingMeterKey('cms.api_request')).toBe(true)
    expect(isBillingMeterKey('cms.typo_meter')).toBe(false)
    expect('event' in parseUsageEvent(measurement())).toBe(true)
    const unknown = parseUsageEvent(measurement({ meterKey: 'cms.not_a_meter' }))
    expect('error' in unknown).toBe(true)
  })

  it('rejects a unit that does not match the meter', () => {
    const parsed = parseUsageEvent(measurement({ unit: 'byte' }))
    expect('error' in parsed).toBe(true)
  })

  it('rejects prices, wallets and business ids', () => {
    const parsed = parseUsageEvent(measurement({ businessId: 'biz_1', price: 10 }))
    expect('error' in parsed).toBe(true)
  })

  it('builds a deterministic hourly event id', () => {
    const first = hourlyEventId(site, 'cms.api_request', hour)
    const later = hourlyEventId(site, 'cms.api_request', new Date('2026-09-26T13:59:00.000Z'))
    expect(first).toBe(later)
    expect(first).toBe(`cms:${site}:api_request:2026-09-26T13:00:00.000Z`)
    expect(deploymentEventId('dep-1')).toBe('cms:dep-1:deployment')
  })

  it('requires a reason and a source on a correction', () => {
    const missing = parseUsageEvent(measurement({ kind: 'correction', quantity: -1 }))
    expect('error' in missing).toBe(true)
    const ok = parseUsageEvent(
      measurement({
        actor: 'cms-fold',
        correctionReason: 'late sample',
        correctsEventId: 'cms:original',
        eventId: correctionEventId('cms:original', -1),
        kind: 'correction',
        quantity: -1,
      }),
    )
    expect('event' in ok).toBe(true)
  })

  it('rejects a batch that names another source', () => {
    const parsed = parseUsageBatch({ contractVersion: 1, events: [measurement()], source: 'somewhere' })
    expect('error' in parsed).toBe(true)
  })

  it('parses committed fixture batches and acks', () => {
    const batch = readFixture('usage-measurement-batch.json')
    expect('batch' in parseUsageBatch(batch)).toBe(true)
    const ack = readFixture('usage-ack.json')
    const parsedAck = parseBatchAck(ack)
    expect('results' in parsedAck).toBe(true)
    if ('results' in parsedAck) expect(parsedAck.results).toHaveLength(3)
    const projection = readFixture('entitlement-push.json')
    expect('input' in parseProjectionInput(projection, 'push')).toBe(true)
  })

  it('rejects legacy aggregate ingest acknowledgements', () => {
    const legacy = parseBatchAck({ accepted: 1, duplicates: 0, rejected: [] })
    expect('error' in legacy).toBe(true)
  })

  it('rejects flat numeric limits on entitlement push', () => {
    const parsed = parseProjectionInput(
      { features: {}, limits: { pages: 10 }, planCode: 'pro', serving: true, siteId: site, version: 1 },
      'push',
    )
    expect('error' in parsed).toBe(true)
  })
})

describe('meters and limits', () => {
  it('does not bill a failed or preview deployment', () => {
    expect(deploymentMeasure({ deploymentId: 'd1', mode: 'edge', siteId: site, status: 'failed' })).toBeNull()
    expect(deploymentMeasure({ deploymentId: 'd1', mode: 'preview', siteId: site, status: 'live' })).toBeNull()
    const live = deploymentMeasure({ deploymentId: 'd1', mode: 'edge', siteId: site, status: 'live' })
    expect(live?.eventId).toBe('cms:d1:deployment')
    expect(live?.quantity).toBe(1)
  })

  it('weights storage by time instead of a snapshot', () => {
    const start = Date.parse('2026-09-26T13:00:00.000Z')
    const clock = emptyStorageClock(start, 3_600n)
    const stepped = advanceStorageClock(clock, start + 3_600_000)
    // 3600 bytes held for one hour is 3600 byte-hours, not a snapshot of the last sample.
    expect(stepped.closed).toEqual([{ byteHours: 3600n, hourStart: start }])
  })

  it('does not meter platform, health or billing paths', () => {
    expect(isBillableCustomerApiPath('http://cms.local/api/pages')).toBe(true)
    expect(isBillableCustomerApiPath('http://cms.local/api/platform/billing/health')).toBe(false)
    expect(isBillableCustomerApiPath('http://cms.local/api/users/me')).toBe(false)
    expect(isBillableCustomerApiPath('http://cms.local/api/users/members')).toBe(true)
    expect(isBillableCustomerApiPath(undefined)).toBe(false)
  })

  it('distinguishes an absent limit from unlimited and from a number', () => {
    const parsed = parseLimitMap({ pages: { state: 'limit', value: 3 }, posts: { state: 'unlimited' } })
    expect('limits' in parsed).toBe(true)
    if (!('limits' in parsed)) return
    expect(limitsToQuota(parsed.limits).pages).toBe(3)
    expect(limitsToQuota(parsed.limits).posts).toBeUndefined()
    expect('error' in parseLimitMap({ pages: { state: 'limit', value: 0 } })).toBe(true)
    expect('error' in parseLimitMap({ notAQuota: { state: 'unlimited' } })).toBe(true)
  })

  it('keeps a technical hold from granting a commercial feature', () => {
    const features = applyTechnicalGate({
      catalogue: [{ key: 'store', technicallyAvailable: false }, { key: 'editor', technicallyAvailable: true }],
      commercial: { editor: true, store: true },
      holds: ['editor'],
    })
    expect(features.find((feature) => feature.key === 'store')?.enabled).toBe(false)
    expect(features.find((feature) => feature.key === 'store')?.commerciallyEntitled).toBe(true)
    expect(features.find((feature) => feature.key === 'editor')?.enabled).toBe(false)
    expect(features.find((feature) => feature.key === 'editor')?.commerciallyEntitled).toBe(true)
  })
})

describe('publisher policy', () => {
  it('backs off without exceeding an hour and dead-letters permanent rejects', () => {
    expect(nextAttemptDelayMs(0, () => 0)).toBe(1_000)
    expect(nextAttemptDelayMs(20, () => 0)).toBeLessThanOrEqual(60 * 60 * 1_000)
    expect(classifyPublishResult('accepted')).toBe('accepted')
    expect(classifyPublishResult('duplicate')).toBe('duplicate')
    expect(classifyPublishResult('rejected', 'unknown_meter')).toBe('rejected')
    expect(classifyPublishResult('rejected', 'timeout')).toBe('transient')
    expect(MAX_PUBLISH_ATTEMPTS).toBe(8)
    expect(OUTBOX_BATCH).toBe(50)
  })

  it('refuses an expired signature and accepts a fresh one', () => {
    const body = '{"events":[]}'
    const now = Date.parse('2026-09-26T13:00:00.000Z')
    const fresh = String(Math.floor(now / 1000))
    const signature = signBillingBody('secret', fresh, body)
    expect(verifyBillingSignature({ body, now, secret: 'secret', signature, timestamp: fresh }).ok).toBe(true)
    const stale = String(Math.floor((now - REPLAY_WINDOW_MS - 1000) / 1000))
    const old = signBillingBody('secret', stale, body)
    expect(verifyBillingSignature({ body, now, secret: 'secret', signature: old, timestamp: stale })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(verifyBillingSignature({ body, now, secret: 'secret', signature: 'nope', timestamp: fresh })).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('pins committed HMAC test vectors', () => {
    for (const vector of readVectors().vectors) {
      expect(signBillingBody(vector.secret, vector.timestampSec, vector.body)).toBe(vector.signature)
      expect(
        verifyBillingSignature({
          body: vector.body,
          now: Number(vector.timestampSec) * 1000,
          secret: vector.secret,
          signature: vector.signature,
          timestamp: vector.timestampSec,
        }).ok,
      ).toBe(true)
    }
  })

  it('isolates the deprecated nonce/body-hash MAC', () => {
    const body = '{"source":"eshobe-cms","events":[]}'
    const timestampMs = '1700000000000'
    const nonce = 'abc123'
    const signature = signLegacyUsageBody({ body, nonce, secret: 'legacy', timestampMs })
    expect(
      verifyLegacyUsageSignature({
        body,
        nonce,
        now: 1700000000000,
        secret: 'legacy',
        signature,
        timestampMs,
      }).ok,
    ).toBe(true)
    expect(
      verifyLegacyUsageSignature({
        body,
        nonce,
        now: 1700000000000,
        secret: 'wrong',
        signature,
        timestampMs,
      }).ok,
    ).toBe(false)
  })

  it('refuses a metadata host as the billing origin', () => {
    expect(() => centralBillingUrl('http://169.254.169.254/latest')).toThrow(/blocked/)
    expect(centralBillingUrl('')).toBeNull()
  })

  it('moves projection versions only forward', () => {
    expect(decideProjectionVersion(null, 1)).toBe('accept')
    expect(decideProjectionVersion(1, 2)).toBe('accept')
    expect(decideProjectionVersion(2, 2)).toBe('idempotent')
    expect(decideProjectionVersion(2, 1)).toBe('stale')
  })
})
