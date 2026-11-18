import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  cartFingerprint,
  COUNTER_PROVIDER,
  isCafeCheckout,
  isCheckoutRequestConflict,
  isCheckoutRequestId,
  isFulfillmentState,
  isPaymentChoice,
  isPaymentState,
  isServiceMode,
  isTableToken,
  parseCafePaymentUpdate,
  refuseServiceMode,
} from '@/lib/cafe-order'
import { orderSubmittedData } from '@/lib/cafe-order'
import { counterProvider } from '@/payments/counter'
import { resolvePaymentProvider } from '@/payments'

/**
 * The café checkout's shared rules, without a database.
 *
 * `tests/int/cafe-checkout.int.spec.ts` proves the endpoint enforces these against real
 * rows; this file pins the rules themselves, because they are the part a reviewer has to
 * be able to read and check — and because a regression here is a regression in every
 * caller that trusts `resolvePaymentProvider` not to move money.
 */
describe('café service mode', () => {
  it('accepts exactly dine-in and takeaway', () => {
    expect(isServiceMode('dine_in')).toBe(true)
    expect(isServiceMode('takeaway')).toBe(true)
    // Delivery and reservations are not offered; a value arriving anyway must not be
    // coerced into one of the two offered modes.
    expect(isServiceMode('delivery')).toBe(false)
    expect(isServiceMode('reservation')).toBe(false)
    expect(isServiceMode(null)).toBe(false)
    expect(isServiceMode(1)).toBe(false)
  })

  it('demands an opaque table token for dine-in and refuses a table for takeaway', () => {
    expect(refuseServiceMode({ serviceMode: 'dine_in', tableToken: null })).toBe('dine_in_requires_table_token')
    expect(refuseServiceMode({ serviceMode: 'dine_in', tableToken: '' })).toBe('dine_in_requires_table_token')
    expect(refuseServiceMode({ serviceMode: 'dine_in', tableToken: 'short' })).toBe('table_token_invalid')
    expect(refuseServiceMode({ serviceMode: 'dine_in', tableToken: 'TBL_9f2c1a4e77b04d0f8c31' })).toBeNull()
    expect(refuseServiceMode({ serviceMode: 'takeaway', tableToken: null })).toBeNull()
    expect(refuseServiceMode({ serviceMode: 'takeaway', tableToken: 'TBL_9f2c1a4e77b04d0f8c31' })).toBe('takeaway_forbids_table_token')
    // Supplied through `unknown`: the endpoint reads this from a request body, where the
    // value is whatever a client sent.
    expect(refuseServiceMode({ serviceMode: 'delivery' as unknown as 'dine_in', tableToken: null })).toBe('unsupported_service_mode')
  })

  it('treats an absent mode as the legacy storefront, and a token without one as half-updated', () => {
    expect(refuseServiceMode({ serviceMode: null, tableToken: null })).toBeNull()
    expect(refuseServiceMode({ serviceMode: null, tableToken: 'TBL_9f2c1a4e77b04d0f8c31' })).toBe('invalid_service_mode')
  })

  it('never lets a table id stand in for a token', () => {
    // A raw UUID is short enough to fail the length bound; more importantly the CMS has
    // no per-table secret to check one against, so anything that looks like an id is
    // only ever carried to Biza, which resolves it inside its own scope.
    expect(isTableToken('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isTableToken('1')).toBe(false)
    expect(isTableToken('has spaces in it')).toBe(false)
    expect(isTableToken('x'.repeat(513))).toBe(false)
  })
})

describe('café checkout classification', () => {
  it('calls a request a café order only when it carries a café field', () => {
    expect(isCafeCheckout({ items: [], name: 'x' })).toBe(false)
    expect(isCafeCheckout({ serviceMode: 'takeaway' })).toBe(true)
    expect(isCafeCheckout({ tableToken: 'TBL_9f2c1a4e77b04d0f8c31' })).toBe(true)
    expect(isCafeCheckout({ paymentChoice: 'counter' })).toBe(true)
    expect(isCafeCheckout({ checkoutRequestId: 'abc12345' })).toBe(true)
  })

  it('accepts an opaque request id of a usable shape only', () => {
    expect(isCheckoutRequestId('a1b2c3d4e5f6')).toBe(true)
    expect(isCheckoutRequestId('short')).toBe(false)
    expect(isCheckoutRequestId('has space here')).toBe(false)
    expect(isCheckoutRequestId('x'.repeat(129))).toBe(false)
    expect(isCheckoutRequestId(42)).toBe(false)
  })

  it('closes the payment choice and the fulfillment vocabulary', () => {
    expect(isPaymentChoice('online')).toBe(true)
    expect(isPaymentChoice('counter')).toBe(true)
    expect(isPaymentChoice('crypto')).toBe(false)
    expect(isFulfillmentState('awaiting_approval')).toBe(true)
    expect(isFulfillmentState('rejected')).toBe(true)
    expect(isFulfillmentState('cooking')).toBe(false)
  })
})

describe('cart fingerprint', () => {
  const line = (productId: string, quantity: number, option = 'oat') => ({
    modifiers: [{ groupId: 'milk', optionIds: [option] }],
    productId,
    quantity,
  })

  it('is stable across line order and across modifier order within a line', () => {
    const a = cartFingerprint([line('p1', 1), line('p2', 2)])
    const b = cartFingerprint([line('p2', 2), line('p1', 1)])

    expect(a).toBe(b)
    expect(a).toHaveLength(28)
  })

  it('changes when the basket changes, in quantity, product or modifier', () => {
    const base = cartFingerprint([line('p1', 1)])

    expect(cartFingerprint([line('p1', 2)])).not.toBe(base)
    expect(cartFingerprint([line('p2', 1)])).not.toBe(base)
    expect(cartFingerprint([line('p1', 1, 'dairy')])).not.toBe(base)
    expect(cartFingerprint([line('p1', 1), line('p2', 1)])).not.toBe(base)
  })

  it('is deterministic across calls — the whole point of a retry key', () => {
    const lines = [line('p1', 3), line('p2', 1, 'dairy')]

    expect(cartFingerprint(lines)).toBe(cartFingerprint(lines))
  })
})

describe('pay at counter', () => {
  it('is registered under the name an order stores', () => {
    expect(COUNTER_PROVIDER).toBe('counter')
    expect(resolvePaymentProvider(COUNTER_PROVIDER).name).toBe('counter')
  })

  it('can never land the buyer on a gateway or confirm one', async () => {
    const initiation = await counterProvider.initiate({
      order: {} as never,
      req: {} as never,
    })

    expect(initiation.redirectUrl).toBeNull()
    expect(initiation.paymentReference).toBeUndefined()
    // No `confirm`: there is no server-side fact to ask about, and an adapter that
    // accepted the browser's word is a checkout callback that marks orders paid.
    expect(counterProvider.confirm).toBeUndefined()
  })

  it('falls back to a method that cannot move money for an unknown provider', () => {
    expect(resolvePaymentProvider('not-a-gateway').name).toBe('bank')
    expect(resolvePaymentProvider(undefined).name).toBe('bank')
  })
})


/**
 * One contract, two producers.
 *
 * `emitOrderSubmitted` (webhook) and `platform/events.ts` (poll feed) both build the
 * `order.submitted` payload with `orderSubmittedData`, so these assertions cover both
 * routes at once: if the builder's key set moves, Biza's fixture and this test fail
 * together instead of the two delivery paths quietly disagreeing in production.
 */
describe('order.submitted payload', () => {
  const order = {
    id: 'ord-1',
    cafe: { fulfillment: 'preparing', serviceMode: 'dine_in', tableToken: 'TBL_9f2c1a4e77b04d0f8c31ab77e0d5' },
    currency: 'IRT',
    payment: { provider: 'counter' },
    reference: 'CMS-1001',
    status: 'pending',
    total: 950,
  }

  it('matches the cross-repo fixture key for key', () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), 'tests/fixtures/store-order-contract/order-submitted-platform-event.json'), 'utf8'),
    ) as { data: Record<string, unknown> }

    expect(Object.keys(orderSubmittedData(order)).sort()).toEqual(Object.keys(fixture.data).sort())
  })

  it('describes a pending counter order without inventing state', () => {
    expect(orderSubmittedData(order)).toMatchObject({
      eventVersion: 1,
      fulfillment: 'preparing',
      orderId: 'ord-1',
      paymentProvider: 'counter',
      paymentStatus: 'pending',
      reference: 'CMS-1001',
      serviceMode: 'dine_in',
      tableToken: 'TBL_9f2c1a4e77b04d0f8c31ab77e0d5',
      total: 950,
    })
  })

  it('normalises a partial projection rather than trusting it', () => {
    // The poll feed selects a projection: no `cafe` group at all, an unknown
    // fulfillment, no payment. Every field still has to be present and typed.
    expect(orderSubmittedData({ id: 'ord-2' })).toEqual({
      currency: null,
      eventVersion: 1,
      fulfillment: 'awaiting_approval',
      orderId: 'ord-2',
      paymentProvider: null,
      paymentStatus: null,
      reference: null,
      serviceMode: null,
      tableToken: null,
      total: null,
    })
  })
})


/**
 * The race-loser path, which is the one place a *successful* idempotent retry can look
 * like a failure. These shapes are copied from what Postgres and Payload actually
 * produce; the translated message is included on purpose, because an earlier version of
 * this check matched the English word "unique" and would have turned every concurrent
 * retry on a Persian-locale deployment into a 500.
 */
describe('checkout request conflict recognition', () => {
  it('recognises the ValidationError Payload builds from a 23505', () => {
    expect(isCheckoutRequestConflict({
      data: { errors: [{ message: 'این مقدار باید منحصر به فرد باشد.', path: 'site_id, cafe_checkout_request_id' }] },
    })).toBe(true)
  })

  it('recognises the raw driver error, wrapped or not', () => {
    const driver = {
      code: '23505',
      detail: 'Key (site_id, cafe_checkout_request_id)=(1, abc12345) already exists.',
    }

    expect(isCheckoutRequestConflict(driver)).toBe(true)
    expect(isCheckoutRequestConflict({ cause: driver })).toBe(true)
  })

  it('does not confuse it with another unique index or a plain validation failure', () => {
    // A product's own unique index, on the same collection of errors.
    expect(isCheckoutRequestConflict({
      data: { errors: [{ message: 'Value must be unique', path: 'reference' }] },
    })).toBe(false)

    // One of the two columns is not enough.
    expect(isCheckoutRequestConflict({
      data: { errors: [{ message: 'Value must be unique', path: 'cafe_checkout_request_id' }] },
    })).toBe(false)

    expect(isCheckoutRequestConflict(null)).toBe(false)
    expect(isCheckoutRequestConflict(new Error('boom'))).toBe(false)
  })
})

/**
 * The payment axis (eshobe-cms#221) is the only path that can move `orders.status`
 * for a café order, so its body is validated here rather than inside the endpoint:
 * a field this refuses is a field the POS cannot write, and `(order, state,
 * reference)` is only an idempotency key if all three are normalised first.
 */
describe('the POS payment axis', () => {
  const body = (payment: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    kind: 'payment',
    payment: {
      amount: 125000,
      currency: 'IRT',
      reference: 'pos-payment-1',
      state: 'paid',
      ...payment,
    },
    ...extra,
  })

  it('accepts exactly the two payment facts the POS witnesses', () => {
    expect(parseCafePaymentUpdate(body())).toEqual({
      amount: 125000,
      currency: 'IRT',
      occurredAt: null,
      reference: 'pos-payment-1',
      state: 'paid',
    })
    expect(parseCafePaymentUpdate(body({ state: 'refunded' }))?.state).toBe('refunded')
    // `occurredAt` is optional, but a real date is kept verbatim for the receipt.
    expect(parseCafePaymentUpdate(body({ occurredAt: '2026-11-17T13:00:00.000Z' }))?.occurredAt)
      .toBe('2026-11-17T13:00:00.000Z')
    // The reference is the idempotency key, so only the trimmed value is stored.
    expect(parseCafePaymentUpdate(body({ reference: '  pos-payment-2  ' }))?.reference).toBe('pos-payment-2')

    // `pending`/`cancelled` are the CMS's own lifecycle; a POS that could write them
    // could walk a payment backwards.
    expect(parseCafePaymentUpdate(body({ state: 'pending' }))).toBeNull()
    expect(parseCafePaymentUpdate(body({ state: 'cancelled' }))).toBeNull()
  })

  it('refuses an amount, currency, reference or timestamp the receipt could not reconcile', () => {
    for (const payment of [
      { amount: 125000.5 },
      { amount: -1 },
      { amount: '125000' },
      { currency: 'XYZ' },
      { currency: 'irt' },
      { reference: '' },
      { reference: '   ' },
      { reference: 'x'.repeat(129) },
      { occurredAt: 'yesterday' },
      { occurredAt: 1763384400000 },
    ]) expect(parseCafePaymentUpdate(body(payment)), JSON.stringify(payment)).toBeNull()

    expect(isPaymentState('paid')).toBe(true)
    expect(isPaymentState('refunded')).toBe(true)
    expect(isPaymentState('pending')).toBe(false)
  })

  it('refuses a body that tries to write outside the allowlist', () => {
    // A total, a buyer or a bare status is what the generic order route would take;
    // this endpoint must not grow into a way to reach it.
    expect(parseCafePaymentUpdate(body({}, { total: 1 }))).toBeNull()
    expect(parseCafePaymentUpdate({ kind: 'payment', payment: { ...body().payment, status: 'paid' } })).toBeNull()
    expect(parseCafePaymentUpdate({ kind: 'payment', payment: { ...body().payment, buyer: {} } })).toBeNull()
    expect(parseCafePaymentUpdate({ kind: 'payment' })).toBeNull()
    expect(parseCafePaymentUpdate({ kind: 'payment', payment: [body().payment] })).toBeNull()
    expect(parseCafePaymentUpdate({ kind: 'payment', ...body().payment })).toBeNull()
    expect(parseCafePaymentUpdate({ kind: 'fulfillment', payment: body().payment })).toBeNull()
    expect(parseCafePaymentUpdate(null)).toBeNull()
  })
})
