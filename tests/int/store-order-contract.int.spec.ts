import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PLATFORM_EVENTS } from '@/lib/saas/events'

const readFixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/store-order-contract', name), 'utf8')) as {
    kind: string
    siteDomain?: string
    siteId?: string
    data: Record<string, unknown> & { orderId?: string }
  }

const fixture = readFixture('order-paid-platform-event.json')
const submittedFixture = readFixture('order-submitted-platform-event.json')

describe('cms-store-order-contract/v1 (platform event slice)', () => {
  it('keeps order.paid in the closed platform vocabulary', () => {
    expect(PLATFORM_EVENTS['order.paid']).toBeTruthy()
  })

  it('pins the poll feed fixture shape used by cafe-restaurant-pos', () => {
    expect(fixture.kind).toBe('order.paid')
    const orderId = fixture.data.orderId
    expect(typeof orderId).toBe('string')
    expect(orderId!.length).toBeGreaterThan(0)
  })
})

/**
 * ESH-150. Biza's copy of this fixture lives in `cafe-restaurant-pos`
 * (`cms-store-order-contract/v1`); these assertions are what fail when the two drift.
 * They deliberately pin the *keys* rather than a sample value, because the contract is
 * a shape, not an instance.
 */
describe('cms-store-order-contract/v1 (order.submitted slice)', () => {
  it('keeps order.submitted in the closed platform vocabulary', () => {
    expect(PLATFORM_EVENTS['order.submitted']).toBeTruthy()
  })

  it('carries exactly the documented fields, with identity and version present', () => {
    expect(submittedFixture.kind).toBe('order.submitted')
    expect(Object.keys(submittedFixture.data).sort()).toEqual([
      'currency',
      'eventVersion',
      'fulfillment',
      'orderId',
      'paymentProvider',
      'paymentStatus',
      'reference',
      'serviceMode',
      'tableToken',
      'total',
    ])

    // `eventVersion` is what lets a receiver move forward without guessing; `orderId`
    // is what converges this event with the later `order.paid`.
    expect(submittedFixture.data.eventVersion).toBe(1)
    expect(typeof submittedFixture.data.orderId).toBe('string')
    expect(typeof submittedFixture.data.reference).toBe('string')
    expect(['dine_in', 'takeaway']).toContain(submittedFixture.data.serviceMode)
  })

  it('says which site and verbatim token, never a table identity of its own', () => {
    expect(typeof submittedFixture.siteId).toBe('string')
    expect(submittedFixture.siteDomain).toBe('cafe.example.test')
    // Opaque: the CMS's only guarantee is that it did not change the value.
    expect(submittedFixture.data.tableToken).toBe('TBL_9f2c1a4e77b04d0f8c31ab77e0d5')
  })

  it('lets a pending (pay-at-counter) order be submitted', () => {
    // A counter order will never produce an order.paid; if this fixture were paid-only
    // the kitchen would never be told about half the orders.
    expect(submittedFixture.data.paymentStatus).toBe('pending')
    expect(submittedFixture.data.paymentProvider).toBe('counter')
  })
})
