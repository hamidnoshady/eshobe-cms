import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PLATFORM_EVENTS } from '@/lib/saas/events'

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/store-order-contract/order-paid-platform-event.json'), 'utf8'),
) as {
  kind: string
  data: { orderId?: string }
}

describe('cms-store-order-contract/v1 (platform event slice)', () => {
  it('keeps order.paid in the closed platform vocabulary', () => {
    expect(PLATFORM_EVENTS['order.paid']).toBeTruthy()
  })

  it('pins the poll feed fixture shape used by cafe-restaurant-pos', () => {
    expect(fixture.kind).toBe('order.paid')
    expect(typeof fixture.data.orderId).toBe('string')
    expect(fixture.data.orderId.length).toBeGreaterThan(0)
  })
})
