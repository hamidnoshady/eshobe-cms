// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { upsertCafeCategory, upsertCafeProduct } from '@/endpoints/cafeMenuSync'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { completeCheckout, startCheckout } from '@/endpoints/checkout'
import type { Order, Product, Site } from '@/payload-types'
import { cartFingerprint } from '@/lib/cafe-order'
import { resetRateLimits } from '@/lib/rate-limit'
import { findForSite } from '@/lib/site-query'
import { cmsTypedUser } from './cmsUser'

/**
 * ESH-150 — the café half of checkout: dine-in from a table QR, takeaway, pay at the
 * counter and the durable `order.submitted` event.
 *
 * Driven through the real handlers (`startCheckout` / `completeCheckout`) with a
 * `createLocalReq`, exactly like `cafe-menu.int.spec.ts` and `store.int.spec.ts`: the
 * Host → tenant resolution, the access control, the relationship validation, the price
 * arithmetic and the hooks are the production path, not a mock of it.
 *
 * Fixtures are the seeded `shop.localhost` (a store site) and `acme.localhost` (a
 * business site) — the pair is what makes the cross-tenant assertions mean something.
 */
let payload: Payload
let shop: Site
let acme: Site
let shopKey = ''
let acmeKey = ''
let posProductId = ''
let posProduct2Id = ''
let nativeProductId = ''
let foreignProductId = ''
const createdProductIds: string[] = []
const createdOrderIds: string[] = []
const keyIds: string[] = []
const suffix = randomUUID()
const productSourceId = `checkout-pos-product-${suffix}`
const product2SourceId = `checkout-pos-product2-${suffix}`
const categorySourceId = `checkout-cafe-category-${suffix}`

const modifiers = [
  {
    sourceId: 'milk',
    label: 'شیر',
    minSelections: 1,
    maxSelections: 1,
    menuOrder: 1,
    active: true,
    options: [
      { sourceId: 'oat', label: 'جو', priceDelta: 25, menuOrder: 1, active: true },
      { sourceId: 'dairy', label: 'معمولی', priceDelta: 0, menuOrder: 2, active: true },
      { sourceId: 'retired', label: 'قدیمی', priceDelta: 5, menuOrder: 3, active: false },
    ],
  },
]

const issueKey = async (siteId: string) => {
  const admin = (await payload.find({ collection: 'users', where: { email: { equals: 'admin@eshobe.test' } }, limit: 1 })).docs[0]!
  expect(admin.role).toBe('platformAdmin')
  const req = await createLocalReq({
    req: { json: async () => ({ name: 'café checkout test', role: 'site', siteId }) } as Partial<PayloadRequest>,
    user: cmsTypedUser(admin),
  }, payload)
  const response = await issueApiKeyEndpoint.handler(req)
  expect(response.status).toBe(201)
  const result = await response.json() as { id: string; key: string }
  keyIds.push(result.id)
  return result.key
}

const request = async ({
  body,
  host = 'shop.localhost',
  key,
  method = 'POST',
  path = '/api/checkout',
  sourceId,
}: {
  body?: unknown
  host?: string
  key?: string
  method?: string
  path?: string
  sourceId?: string
}): Promise<PayloadRequest> => {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = await createLocalReq({
    req: {
      body,
      headers: new Headers({
        'content-length': String(text.length),
        'content-type': 'application/json',
        host,
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      }),
      method,
      payloadAPI: 'REST',
      ...(sourceId ? { routeParams: { sourceId } } : {}),
      text: async () => text,
      url: `http://${host}${path}`,
    } as Partial<PayloadRequest>,
  }, payload)
  req.context.disableRevalidate = true
  return req
}

const syncProduct = async (sourceId: string, body: object) => {
  const response = await upsertCafeProduct(await request({
    body,
    key: shopKey,
    method: 'PUT',
    path: '/api/site/cafe-menu/products/x',
    sourceId,
  }))
  return { body: await response.json() as { id?: string; message?: string }, status: response.status }
}

const checkout = async (body: object, host = 'shop.localhost') =>
  startCheckout(await request({ body, host }))

const orderById = async (id: string): Promise<Order> =>
  payload.findByID({ collection: 'orders', depth: 0, id, overrideAccess: true })

const orderIdOf = async (response: Response): Promise<string> => {
  const body = await response.json() as { confirmationUrl?: string; message?: string }
  expect(body.confirmationUrl, JSON.stringify(body)).toBeTruthy()
  const id = body.confirmationUrl!.match(/checkout\/([^?]+)/)?.[1]
  expect(id).toBeTruthy()
  createdOrderIds.push(String(id))
  return String(id)
}

const buyer = { name: 'میزبان', phone: '09123456789' }
/** A fresh idempotency key, so each of these tests creates a genuinely new order. */
const newRequest = () => ({ checkoutRequestId: `test${randomUUID().replace(/-/g, '')}` })
const TABLE = 'TBL_9f2c1a4e77b04d0f8c31ab77'
const item = (productId: string, quantity = 1, option = 'oat') => ({
  product: productId,
  quantity,
  modifiers: [{ groupId: 'milk', optionIds: [option] }],
})

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const sites = (await payload.find({ collection: 'sites', depth: 0, pagination: false })).docs
  shop = sites.find((site) => site.domain === 'shop.localhost')!
  acme = sites.find((site) => site.domain === 'acme.localhost')!
  expect(shop && acme).toBeTruthy()

  shopKey = await issueKey(shop.id)
  acmeKey = await issueKey(acme.id)

  const category = await upsertCafeCategory(await request({
    body: { name: 'قهوهٔ تست سفارش' },
    key: shopKey,
    method: 'PUT',
    path: '/api/site/cafe-menu/categories/x',
    sourceId: categorySourceId,
  }))
  expect(category.status).toBe(200)

  const first = await syncProduct(productSourceId, {
    title: 'لاتهٔ سفارش',
    price: 100,
    menuOrder: 1,
    menuAvailability: 'available',
    trackInventory: true,
    inventory: 20,
    categorySourceIds: [categorySourceId],
    modifierGroups: modifiers,
  })
  expect(first.status, JSON.stringify(first.body)).toBe(200)
  posProductId = first.body.id!
  createdProductIds.push(posProductId)
  await payload.update({ collection: 'products', id: posProductId, data: { _status: 'published' }, overrideAccess: true, context: { disableRevalidate: true } })

  const second = await syncProduct(product2SourceId, {
    title: 'کیک سفارش',
    price: 200,
    menuOrder: 2,
    menuAvailability: 'available',
    trackInventory: true,
    inventory: 10,
    categorySourceIds: [categorySourceId],
    modifierGroups: [],
  })
  expect(second.status, JSON.stringify(second.body)).toBe(200)
  posProduct2Id = second.body.id!
  createdProductIds.push(posProduct2Id)
  await payload.update({ collection: 'products', id: posProduct2Id, data: { _status: 'published' }, overrideAccess: true, context: { disableRevalidate: true } })

  // A CMS-owned product: café orders must not settle *its* stock either, and an ordinary
  // store order must keep settling it — that pair is the stock-ownership assertion.
  const native = await payload.create({
    collection: 'products',
    context: { disableRevalidate: true },
    data: {
      _status: 'published',
      inventory: 5,
      price: 300,
      site: shop.id,
      slug: `cafe-checkout-native-${suffix}`,
      title: 'کالای داخلی',
      trackInventory: true,
    },
    overrideAccess: true,
  })
  nativeProductId = native.id
  createdProductIds.push(native.id)

  const foreign = await upsertCafeProduct(await request({
    body: { price: 999, title: 'کالای سایت دیگر' },
    key: acmeKey,
    method: 'PUT',
    path: '/api/site/cafe-menu/products/x',
    sourceId: productSourceId,
  }))
  expect(foreign.status).toBe(200)
  foreignProductId = (await foreign.json() as { id: string }).id
  createdProductIds.push(foreignProductId)
  await payload.update({ collection: 'products', id: foreignProductId, data: { _status: 'published' }, overrideAccess: true, context: { disableRevalidate: true } })

  resetRateLimits()
}, 240_000)

afterAll(async () => {
  if (!payload) return
  for (const id of createdOrderIds) {
    await payload.delete({ collection: 'orders', id, overrideAccess: true }).catch(() => undefined)
  }
  for (const id of createdProductIds) {
    await payload.delete({ collection: 'products', id, overrideAccess: true, context: { disableRevalidate: true } }).catch(() => undefined)
  }
  const terms = await payload.find({
    collection: 'taxonomy-terms',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { menuSourceId: { equals: categorySourceId } },
  })
  for (const doc of terms.docs) await payload.delete({ collection: 'taxonomy-terms', id: doc.id, overrideAccess: true }).catch(() => undefined)
  const audits = await payload.find({
    collection: 'audit-log',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: { targetId: { in: createdOrderIds } },
  })
  for (const doc of audits.docs) await payload.delete({ collection: 'audit-log', id: doc.id, overrideAccess: true }).catch(() => undefined)
  for (const id of keyIds) await payload.delete({ collection: 'api-keys', id, overrideAccess: true }).catch(() => undefined)
}, 240_000)

describe.sequential('café checkout (ESH-150)', () => {
  it('submits a multi-line dine-in order from a table token and prices every line on the server', async () => {
    const response = await checkout({
      ...buyer,
      ...newRequest(),
      // Every client-supplied price and total below is wrong on purpose.
      items: [
        { ...item(posProductId, 2, 'oat'), unitPrice: 1, total: 1 },
        { ...item(posProductId, 1, 'dairy'), price: 1 },
        { product: posProduct2Id, quantity: 3, price: 1, modifiers: [] },
      ],
      paymentChoice: 'counter',
      serviceMode: 'dine_in',
      tableToken: TABLE,
      total: 1,
    })

    const body = await response.json() as { message?: string; orderId?: string; paymentChoice?: string; redirectUrl?: null | string }
    expect(response.status, JSON.stringify(body)).toBe(200)
    // Pay at the counter never reaches a gateway, so there is nothing to redirect to.
    expect(body.paymentChoice).toBe('counter')
    expect(body.redirectUrl).toBeNull()

    const order = await orderById(await orderIdOf(response))
    // (100 + 25) × 2 + (100 + 0) × 1 + 200 × 3 = 250 + 100 + 600
    expect(order.total).toBe(950)
    expect(order.items?.map((line) => line.unitPrice)).toEqual([125, 100, 200])
    expect(order.items?.[0]?.modifiers?.[0]).toMatchObject({
      groupSourceId: 'milk',
      groupLabel: 'شیر',
      optionLabel: 'جو',
      optionSourceId: 'oat',
      priceDelta: 25,
      quantity: 1,
    })
    expect(order.status).toBe('pending')
    expect(order.payment.provider).toBe('counter')
    expect(order.cafe).toMatchObject({
      fulfillment: 'awaiting_approval',
      paymentChoice: 'counter',
      serviceMode: 'dine_in',
      tableToken: TABLE,
    })
    // The legacy first-line mirror stays populated for receipts and older integrations.
    expect(order.product).toBe(posProductId)
    expect(order.quantity).toBe(2)
    expect(order.unitPrice).toBe(125)
  })

  it('records exactly one durable order.submitted for a café order, before payment', async () => {
    const order = await orderById(createdOrderIds[0]!)

    const audits = await payload.find({
      collection: 'audit-log',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { and: [{ action: { equals: 'order.submitted' } }, { targetId: { equals: String(order.id) } }] },
    })

    expect(audits.totalDocs).toBe(1)
    const data = (audits.docs[0] as { changes?: Record<string, unknown> }).changes ?? {}
    expect(data).toMatchObject({
      eventVersion: 1,
      fulfillment: 'awaiting_approval',
      orderId: String(order.id),
      paymentProvider: 'counter',
      paymentStatus: 'pending',
      reference: order.reference,
      serviceMode: 'dine_in',
      tableToken: TABLE,
    })
  })

  it('takes a takeaway order without a table, and rejects a table on one', async () => {
    const withTable = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
      tableToken: TABLE,
    })
    expect(withTable.status).toBe(400)

    const response = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })
    expect(response.status).toBe(200)
    const order = await orderById(await orderIdOf(response))
    expect(order.cafe?.serviceMode).toBe('takeaway')
    expect(order.cafe?.tableToken ?? null).toBeNull()
  })

  it('refuses dine-in without a token, with a malformed one, and refuses delivery outright', async () => {
    const noToken = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'dine_in',
    })
    expect(noToken.status).toBe(400)
    expect((await noToken.json() as { message: string }).message).toContain('نشان میز')

    const badToken = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'dine_in',
      tableToken: 'has spaces',
    })
    expect(badToken.status).toBe(400)

    // Delivery/reservations are not offered by this flow at all — the value is refused,
    // never coerced into takeaway.
    const delivery = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'delivery',
    })
    expect(delivery.status).toBe(400)
  })

  it('keeps products on their own site, and never judges a token that is not its own', async () => {
    // A shop product is not readable from the acme site: the site-scoped re-read is what
    // makes this fail, not a check on the id.
    const foreignToAcme = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    }, 'acme.localhost')
    expect(foreignToAcme.status).toBeGreaterThanOrEqual(400)

    // The mirror case, on the *shop* site, with a product that belongs to acme.
    const foreignToShop = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(foreignProductId, 1, 'oat')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })
    expect(foreignToShop.status).toBeGreaterThanOrEqual(400)

    // A token's *validity* is not a question this CMS can answer, so a dine-in order on
    // the shop site is accepted and the token stored verbatim — Biza resolves it inside
    // its own scope, and an endpoint that said "no such table" here would let anyone
    // probe another tenant's. What must never happen is the CMS reading the token to
    // decide something: the stored value is byte-identical to the one submitted.
    const accepted = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'dine_in',
      tableToken: TABLE,
    })
    expect(accepted.status).toBe(200)
    const stored = await orderById(await orderIdOf(accepted))
    expect(stored.site === shop.id || (stored.site as { id?: string })?.id === shop.id).toBe(true)
    expect(stored.cafe?.tableToken).toBe(TABLE)
  })

  it('refuses a token that is padded or carries control characters', async () => {
    const response = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'dine_in',
      tableToken: 'TBL_9f2c1a4e 77b04d0f8c31',
    })
    expect(response.status).toBe(400)
  })

  it('refuses a café order that carries no checkout request id', async () => {
    // Without the key the endpoint cannot distinguish a lost response from a second
    // order, and both guesses are wrong — so it refuses instead of guessing.
    const response = await checkout({
      ...buyer,
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })

    expect(response.status).toBe(400)
    expect((await response.json() as { message: string }).message).toContain('صفحه را دوباره باز کنید')
  })

  it('treats the same request id and basket as a retry, and a changed basket under it as an error', async () => {
    const requestId = `retry${randomUUID().replace(/-/g, '')}`
    const body = {
      ...buyer,
      checkoutRequestId: requestId,
      items: [item(posProductId, 1, 'oat')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    }

    const first = await checkout(body)
    expect(first.status).toBe(200)
    const firstId = await orderIdOf(first)

    const retry = await checkout(body)
    expect(retry.status).toBe(200)
    const retryBody = await retry.json() as { orderId: string; retry?: boolean }
    expect(retryBody.orderId).toBe(firstId)
    expect(retryBody.retry).toBe(true)

    // A second *distinct* order from the same phone is legitimate: a table of four
    // ordering separately must not be blocked by the storefront's duplicate guard.
    const second = await checkout({ ...body, checkoutRequestId: `${requestId}x` })
    expect(second.status).toBe(200)
    const secondId = await orderIdOf(second)
    expect(secondId).not.toBe(firstId)

    // The same key with a different basket is a stale key, not a retry.
    const stale = await checkout({
      ...body,
      items: [item(posProductId, 4, 'oat')],
    })
    expect(stale.status).toBe(409)

    const count = await payload.count({
      collection: 'orders',
      where: {
        and: [
          { site: { equals: shop.id } },
          { 'cafe.checkoutRequestId': { equals: requestId } },
        ],
      },
    })
    expect(count.totalDocs).toBe(1)
  })

  it('converges concurrent retries of one request id onto one order', async () => {
    const requestId = `race${randomUUID().replace(/-/g, '')}`
    const body = {
      ...buyer,
      checkoutRequestId: requestId,
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    }

    const responses = await Promise.all([checkout(body), checkout(body)])
    for (const response of responses) expect(response.status).toBe(200)
    const ids = await Promise.all(responses.map((response) => orderIdOf(response)))
    expect(new Set(ids).size).toBe(1)

    const count = await payload.count({
      collection: 'orders',
      where: { and: [{ site: { equals: shop.id } }, { 'cafe.checkoutRequestId': { equals: requestId } }] },
    })
    expect(count.totalDocs).toBe(1)
  })

  it('never lets a callback make a pay-at-counter order paid', async () => {
    const order = await orderById(createdOrderIds[0]!)
    const callback = await completeCheckout(await request({
      host: 'shop.localhost',
      method: 'GET',
      path: `/api/checkout/callback?order=${order.id}&status=ok&success=1`,
    }))

    // A browser is redirected to the receipt, and the order is still unpaid.
    expect([302, 200]).toContain(callback.status)
    const after = await orderById(String(order.id))
    expect(after.status).toBe('pending')
    expect(after.payment.provider).toBe('counter')
  })

  it('leaves POS inventory alone on a café order but still settles CMS-owned store orders', async () => {
    const posBefore = (await payload.findByID({ collection: 'products', id: posProductId, depth: 0, overrideAccess: true })) as Product
    const nativeBefore = (await payload.findByID({ collection: 'products', id: nativeProductId, depth: 0, overrideAccess: true })) as Product

    const cafe = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProductId, 2, 'oat'), { product: nativeProductId, modifiers: [], quantity: 1 }],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })
    const cafeId = await orderIdOf(cafe)
    await payload.update({
      collection: 'orders',
      context: { disableRevalidate: true },
      data: { status: 'paid' },
      id: cafeId,
      overrideAccess: true,
    })

    const posAfter = (await payload.findByID({ collection: 'products', id: posProductId, depth: 0, overrideAccess: true })) as Product
    const nativeAfterCafe = (await payload.findByID({ collection: 'products', id: nativeProductId, depth: 0, overrideAccess: true })) as Product
    expect(posAfter.inventory).toBe(posBefore.inventory)
    // A café order is a POS ticket end to end: even a CMS-owned line does not move here,
    // because the POS owns the fulfilment and its own stock ledger.
    expect(nativeAfterCafe.inventory).toBe(Number(nativeBefore.inventory))

    // An ordinary store order keeps the behaviour it always had.
    const storeOrder = await payload.create({
      collection: 'orders',
      context: { disableRevalidate: true },
      data: {
        buyer,
        currency: 'IRT',
        items: [{ product: nativeProductId, productTitle: 'کالای داخلی', quantity: 2, subtotal: 600, taxTotal: 0, total: 600, unitPrice: 300 }],
        payment: { provider: 'bank' },
        product: nativeProductId,
        productTitle: 'کالای داخلی',
        quantity: 2,
        reference: `ESH-TEST-${randomUUID().slice(0, 6)}`,
        site: shop.id,
        status: 'pending',
        subtotal: 600,
        total: 600,
        unitPrice: 300,
      },
      overrideAccess: true,
    })
    createdOrderIds.push(String(storeOrder.id))
    await payload.update({
      collection: 'orders',
      context: { disableRevalidate: true },
      data: { status: 'paid' },
      id: storeOrder.id,
      overrideAccess: true,
    })
    const nativeAfterStore = (await payload.findByID({ collection: 'products', id: nativeProductId, depth: 0, overrideAccess: true })) as Product
    expect(nativeAfterStore.inventory).toBe(Number(nativeBefore.inventory) - 2)
  })

  it('does not echo order.paid back when a counter order is settled, but does for a verified online one', async () => {
    const counterOrder = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })
    const counterId = await orderIdOf(counterOrder)

    await payload.update({
      collection: 'orders',
      context: { disableRevalidate: true },
      data: { status: 'paid' },
      id: counterId,
      overrideAccess: true,
    })

    const echoed = await payload.find({
      collection: 'audit-log',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { and: [{ action: { equals: 'order.paid' } }, { targetId: { equals: counterId } }] },
    })
    expect(echoed.totalDocs).toBe(0)

    // A store order marked paid by staff still announces it: that is a fact only the
    // CMS knows, and it is what the POS's own accounting import listens for.
    const storeOrder = await payload.create({
      collection: 'orders',
      context: { disableRevalidate: true },
      data: {
        buyer,
        currency: 'IRT',
        items: [{ product: posProduct2Id, productTitle: 'کیک سفارش', quantity: 1, subtotal: 200, taxTotal: 0, total: 200, unitPrice: 200 }],
        payment: { provider: 'bank' },
        product: posProduct2Id,
        productTitle: 'کیک سفارش',
        quantity: 1,
        reference: `ESH-TEST-${randomUUID().slice(0, 6)}`,
        site: shop.id,
        status: 'pending',
        subtotal: 200,
        total: 200,
        unitPrice: 200,
      },
      overrideAccess: true,
    })
    createdOrderIds.push(String(storeOrder.id))
    await payload.update({
      collection: 'orders',
      context: { disableRevalidate: true },
      data: { status: 'paid' },
      id: storeOrder.id,
      overrideAccess: true,
    })
    const paid = await payload.find({
      collection: 'audit-log',
      depth: 0,
      overrideAccess: true,
      pagination: false,
      where: { and: [{ action: { equals: 'order.paid' } }, { targetId: { equals: String(storeOrder.id) } }] },
    })
    expect(paid.totalDocs).toBe(1)
  })

  it('keeps the legacy one-product storefront byte-for-byte compatible', async () => {
    const response = await checkout({ ...buyer, product: nativeProductId, quantity: 2 })

    // No café fields were sent, so none may appear — and the duplicate guard the café
    // path bypasses still applies here.
    if (response.status === 200) {
      const order = await orderById(await orderIdOf(response))
      expect(order.cafe?.serviceMode ?? null).toBeNull()
      expect(order.payment.provider).not.toBe('counter')
    } else {
      // The seeded store has no gateway configured for this amount, which is a 503 with
      // a receipt — either way, no café semantics leaked in.
      const body = await response.json() as { confirmationUrl?: string }
      expect(body.confirmationUrl).toBeTruthy()
      const id = body.confirmationUrl!.match(/checkout\/([^?]+)/)![1]!
      createdOrderIds.push(id)
      const order = await orderById(id)
      expect(order.cafe?.serviceMode ?? null).toBeNull()
    }
  })

  it('forces the external-inventory snapshot onto every POS line, whatever the client sends', async () => {
    const response = await checkout({
      ...buyer,
      ...newRequest(),
      items: [{ ...item(posProductId, 1, 'oat'), externalInventory: false }],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
      total: 1,
    })
    const order = await orderById(await orderIdOf(response))
    expect(order.items?.[0]?.externalInventory).toBe(true)
    expect(order.cafe?.cartFingerprint).toBe(
      cartFingerprint([{ modifiers: [{ groupId: 'milk', optionIds: ['oat'] }], productId: posProductId, quantity: 1, variation: '' }]),
    )
  })

  it('puts order.submitted on the poll feed with a stable id and the token verbatim', async () => {
    const { platformEvents } = await import('@/platform/events')
    const order = await orderById(createdOrderIds[0]!)
    const feed = await platformEvents(await request({ method: 'GET', path: '/api/platform/events' }), { limit: 500 })
    const submitted = feed.events.filter((event) => event.kind === 'order.submitted' && event.data?.orderId === String(order.id))

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({
      data: { serviceMode: 'dine_in', tableToken: TABLE },
      siteId: shop.id,
    })
    // Delivery/replay safety: the id is stable for the same record, so a poller that
    // asks twice for the same window drops the duplicate rather than re-importing it.
    const again = await platformEvents(await request({ method: 'GET', path: '/api/platform/events' }), { limit: 500 })
    expect(again.events.find((event) => event.kind === 'order.submitted' && event.data?.orderId === String(order.id))?.id)
      .toBe(submitted[0]!.id)
  })

  it('lets the POS move only the kitchen state through its site key', async () => {
    const created = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })
    const id = await orderIdOf(created)
    const before = await orderById(id)

    // A keyed request, exactly as the POS makes it: `overrideAccess: false` so the
    // site-key access rules and `restrictApiKeyOrderWrite` are both in the path.
    const keyed = await request({ key: shopKey, method: 'PATCH', path: `/api/orders/${id}` })

    // The POS accepts the ticket and — in the same call, out of habit or malice —
    // rewrites the total, the buyer, the reference and the café facts.
    const updated = await payload.update({
      collection: 'orders',
      data: {
        cafe: { fulfillment: 'accepted' },
        buyer: { name: 'کسی دیگر', phone: '09000000000' },
        reference: 'HIJACKED',
        status: 'paid',
        total: 1,
      } as never,
      id,
      overrideAccess: false,
      req: keyed,
    })

    // What it earned: the status transition and the kitchen state.
    expect(updated.status).toBe('paid')
    expect(updated.cafe?.fulfillment).toBe('accepted')
    expect(updated.cafe?.fulfillmentAt).toBeTruthy()
    // What it did not: every commerce fact stays exactly as the checkout wrote it.
    expect(updated.total).toBe(before.total)
    expect(updated.reference).toBe(before.reference)
    expect(updated.buyer?.phone).toBe(before.buyer?.phone)
    expect(updated.cafe?.serviceMode).toBe('takeaway')
    expect(updated.cafe?.checkoutRequestId).toBe(before.cafe?.checkoutRequestId)
    expect(updated.cafe?.tableToken ?? null).toBeNull()
  })

  it('refuses a fulfillment state outside the closed vocabulary', async () => {
    const created = await checkout({
      ...buyer,
      ...newRequest(),
      items: [item(posProduct2Id, 1, 'dairy')],
      paymentChoice: 'counter',
      serviceMode: 'takeaway',
    })
    const id = await orderIdOf(created)
    const keyed = await request({ key: shopKey, method: 'PATCH', path: `/api/orders/${id}` })

    // Either Payload's own select validation refuses the write or the hook drops the
    // value; both are acceptable, silently storing it is not.
    await payload.update({
      collection: 'orders',
      data: { cafe: { fulfillment: 'microwaved' }, status: 'pending' } as never,
      id,
      overrideAccess: false,
      req: keyed,
    }).catch(() => undefined)

    const after = await orderById(id)
    expect(after.cafe?.fulfillment).toBe('awaiting_approval')
    expect(after.status).toBe('pending')
  })

  it('hides a foreign café order from this site’s scoped read', async () => {
    const orderId = createdOrderIds[0]!
    const scoped = await findForSite('orders', String(acme.id), { pagination: false, where: { id: { equals: orderId } } })
    expect(scoped.docs).toHaveLength(0)
  })
})
