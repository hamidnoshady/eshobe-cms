import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { createServer, type Server } from 'node:http'

import type { Where } from 'payload'

import type { CurrencyCode } from '@/lib/money'
import type { PaymentProviderName } from '@/payments'

import type { Order, Product, Site } from '@/payload-types'

import config from '@/payload.config'
import { completeCheckout, startCheckout } from '@/endpoints/checkout'
import { resetRateLimits } from '@/lib/rate-limit'
import { findForSite } from '@/lib/site-query'
import { readOrderDocs, signOrderReceipt, verifyOrderReceipt } from '@/lib/order-receipt'

/**
 * Wave 7 — the store. Run `pnpm seed` first; the fixtures are the seeded
 * `shop.localhost` (a `store` site) and `acme.localhost` (a business site), which is
 * what makes the cross-tenant assertions mean something.
 *
 * The checkout endpoint is driven through `createLocalReq` rather than a running
 * dev server, with `text()` supplied so `addDataAndFileToRequest` parses the body the
 * same way it does on a real request. Everything past that point — Host → tenant,
 * access control, relationship validation, the gateway call — is the production code
 * path, not a mock of it.
 */
let payload: Payload

const idOf = (value: unknown): string =>
  typeof value === 'object' && value !== null
    ? String((value as { id: string }).id)
    : String(value)

const site = async (domain: string): Promise<Site> => {
  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    where: { domain: { equals: domain } },
  })

  const doc = docs[0]

  if (!doc) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)

  return doc as Site
}

const product = async (where: Where): Promise<Product> => {
  const { docs } = await payload.find({
    collection: 'products',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where,
  })

  const doc = docs[0]

  if (!doc) throw new Error(`No product matching ${JSON.stringify(where)} — run \`pnpm seed\``)

  return doc as Product
}

/**
 * A request shaped like the ones Payload's REST handler produces: JSON body, a
 * `Host` that belongs to one customer, and a URL.
 */
const request = ({
  body,
  host,
  method = 'POST',
  path,
  user,
}: {
  body?: unknown
  host: string
  method?: 'GET' | 'POST'
  path: string
  user?: TypedUser
}): Promise<PayloadRequest> => {
  const text = body === undefined ? '' : JSON.stringify(body)

  return createLocalReq(
    {
      req: {
        body,
        headers: new Headers({
          'content-length': String(text.length),
          'content-type': 'application/json',
          host,
        }),
        method,
        text: () => Promise.resolve(text),
        url: `http://${host}${path}`,
      } as Partial<PayloadRequest>,
      user,
    },
    payload,
  )
}


/**
 * A guard on the seed itself, in its own suite because every other test here
 * repoints the store's payment provider: `paymentInstructions` is localized, and a
 * Local-API write that does not name a locale does not necessarily land in the site's
 * default one — the value then reads back as `null` on the Persian receipt page, which
 * is a bug invisible in the admin and fatal on the storefront. The seed passes
 * `locale` on every localized write; this is what keeps that true.
 */
describe('seeded store fixture', () => {
  let payload: Payload

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  }, 180_000)

  it('writes the store document in the locale the storefront reads', async () => {
    const { docs } = await payload.find({
      collection: 'store',
      depth: 0,
      limit: 1,
      locale: 'fa',
      overrideAccess: true,
      where: { 'site.domain': { equals: 'shop.localhost' } },
    })

    const instructions = docs[0]?.paymentInstructions

    // The shape first: an object here means the read came back across locales, which
    // is the same bug wearing a different hat.
    expect(typeof instructions).toBe('string')
    expect(instructions).toMatch('کارت')
  })
})

describe('store', () => {
  let shop: Site
  let acme: Site
  let shopOwner: TypedUser
  let tracked: Product
  let draft: Product
  let foreign: Product
  let cleanup: string[] = []
  let storeFixture: null | (StoreFields & { id: string }) = null
  let inventoryFixture: number | null | undefined = null

  type StoreFields = {
    currency: CurrencyCode
    paymentProvider: PaymentProviderName
  }

  beforeAll(async () => {
    payload = await getPayload({ config: await config })

    shop = await site('shop.localhost')
    acme = await site('acme.localhost')

    tracked = await product({ title: { equals: 'سوهان هل' }, site: { equals: shop.id } })
    draft = await product({ title: { equals: 'گلاب دوآتیشه' }, site: { equals: shop.id } })
    foreign = await product({ title: { equals: 'زعفران سرگل' }, site: { equals: shop.id } })

    shopOwner = (
      await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        where: { email: { equals: 'shop@eshobe.test' } },
      })
    ).docs[0] as TypedUser

    // A product on a *business* site: it must never appear on the store, never be
    // buyable from it, and never be selectable into its orders.
    const created = await payload.create({
      collection: 'products',
      context: { disableRevalidate: true },
      data: {
        _status: 'published',
        price: 75_000,
        site: acme.id,
        slug: 'mahsool-azmayeshi-acme',
        title: 'محصول آزمایشی آکمه',
        trackInventory: false,
      },
      overrideAccess: true,
    })

    foreign = created as Product
    cleanup = [created.id]

    // The seed's own values, captured so the suite can hand the dev database back the
    // way it found it. These tests deliberately flip the store between `bank` and
    // `http` and burn stock down to zero; leaving that behind makes the seeded site
    // lie to whoever opens a browser next.
    const { docs: storeDocs } = await payload.find({
      collection: 'store',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: shop.id } },
    })

    const seeded = storeDocs[0]

    if (seeded) {
      storeFixture = {
        currency: seeded.currency,
        id: seeded.id,
        paymentProvider: seeded.paymentProvider,
      }
    }

    inventoryFixture = (await product({ title: { equals: 'سوهان هل' } })).inventory
  }, 180_000)

  afterAll(async () => {
    delete process.env.CHECKOUT_RATE_LIMIT
    delete process.env.CHECKOUT_DUPLICATE_WINDOW_MINUTES

    resetRateLimits()

    for (const id of cleanup) {
      await payload.delete({ collection: 'products', context: { disableRevalidate: true }, id })
    }

    await payload.delete({
      collection: 'orders',
      overrideAccess: true,
      where: { 'buyer.name': { in: ['سارا', 'ربات', 'خریدار'] } },
    })

    await payload.update({
      collection: 'products',
      context: { disableRevalidate: true },
      data: { inventory: inventoryFixture, trackInventory: true },
      id: tracked.id,
      overrideAccess: true,
    })

    if (storeFixture) {
      const { id, ...data } = storeFixture

      await payload.update({ collection: 'store', data, id, overrideAccess: true })
    }
  })

  beforeEach(async () => {
    // Neutralise the two abuse guards unless the test asks for them: left at production
    // values they throttle this suite mid-run, and a 429 in a tenancy assertion is the
    // worst possible shape for a failure. In `beforeEach` rather than `beforeAll` so a
    // test that flips them and then fails cannot leave the rest of the file switched on.
    process.env.CHECKOUT_RATE_LIMIT = '10000'
    process.env.CHECKOUT_DUPLICATE_WINDOW_MINUTES = '0'

    resetRateLimits()

    // Every test starts from a known stock count and a `bank` site.
    await payload.update({
      collection: 'products',
      context: { disableRevalidate: true },
      data: { inventory: 2, trackInventory: true },
      id: (await product({ title: { equals: 'سوهان هل' } })).id,
      overrideAccess: true,
    })

    await setStoreSettings({ currency: 'IRT', paymentProvider: 'bank' })
  })

  describe('catalogue tenancy', () => {
    it('lists only the store’s own published products', async () => {
      const { docs } = await findForSite('products', String(shop.id), {
        locale: 'fa',
        pagination: false,
        where: { _status: { equals: 'published' } },
      })

      const titles = docs.map((doc) => doc.title)

      expect(titles).toContain('سوهان هل')
      // The seeded draft is a product of the same site: `draft: false` would not
      // have hidden it, the access-control where-clause is what does.
      expect(titles).not.toContain('گلاب دوآتیشه')
      expect(titles).not.toContain('محصول آزمایشی آکمه')
      expect(new Set(docs.map((doc) => idOf(doc.site))).size).toBe(1)
    })

    it('hides a draft product from the storefront and shows it to the site’s owner', async () => {
      const anonymous = await findForSite('products', String(shop.id), { locale: 'fa', pagination: false })

      expect(anonymous.docs.map((doc) => doc.title)).not.toContain(draft.title)

      const asOwner = await payload.find({
        collection: 'products',
        overrideAccess: false,
        pagination: false,
        user: shopOwner,
      })

      expect(asOwner.docs.map((doc) => doc.title)).toContain(draft.title)
      expect(new Set(asOwner.docs.map((doc) => idOf(doc.site)))).toEqual(new Set([String(shop.id)]))
    })

    it('refuses the other site’s product by id', async () => {
      const stolen = await payload.findByID({
        id: foreign.id,
        collection: 'products',
        disableErrors: true,
        overrideAccess: false,
        user: shopOwner,
      })

      expect(stolen).toBeNull()
    })

    it('will not let a store order another site’s product', async () => {
      // The mechanism is the one the Wave 7 spike found in the multi-tenant plugin:
      // it rewrites every relationship field's `filterOptions` with the *document's*
      // own tenant, and Payload validates relationship values against `filterOptions`
      // on save. Same rule, our collection.
      const error = await payload
        .create({
          collection: 'orders',
          data: {
            buyer: { name: 'خریدار', phone: '09121234567' },
            // Required by the type, normally filled by the order's own hook.
            reference: 'ESH-TESTCASE',
            currency: 'IRT',
            payment: { provider: 'bank' },
            product: foreign.id,
            quantity: 1,
            site: shop.id,
            status: 'pending',
            total: 75_000,
            unitPrice: 75_000,
          },
          overrideAccess: true,
        })
        .then(() => null)
        .catch((err: unknown) => err as { data?: { errors?: { message: string; path: string }[] } })

      expect(error?.data?.errors?.map((e) => e.path)).toContain('product')
    })

    it('keeps the per-site store document per site', async () => {
      const { docs } = await findForSite('store', String(shop.id), { locale: 'fa' })

      expect(docs).toHaveLength(1)
      expect(docs[0]?.currency).toBe('IRT')

      const other = await findForSite('store', String(acme.id), { locale: 'fa' })

      expect(other.docs).toHaveLength(0)
    })

    it('registers every content collection with the multi-tenant plugin', () => {
      /**
       * CLAUDE.md's leak rule, as a test: a collection missing from the plugin's
       * `collections` map is shared by every customer with no error and no warning —
       * which is exactly how `products` would have shipped if Wave 7 had added the
       * collections and forgotten the map.
       *
       * The plugin's only observable effect on a collection is the tenant field it
       * prepends, so that is what is asserted.
       */
      const platformWide = new Set([
        // The tenant itself, and the users collection the plugin handles separately
        // via its `tenants` array (a `site` field on a user would double-scope).
        'sites',
        'users',
        // Payload's own tables: no tenant to scope by.
        'payload-jobs',
        'payload-kv',
        'payload-locked-documents',
        'payload-migrations',
        'payload-preferences',
      ])

      type Shape = { fields?: { name?: string }[]; slug: string }

      const unscoped = (payload.config.collections as unknown as (Shape & { config?: Shape })[])
        .map((entry) => entry.config ?? entry)
        .filter((collection) => !platformWide.has(collection.slug))
        .filter((collection) => !collection.slug.startsWith('payload-'))
        .filter((collection) => !(collection.fields ?? []).some((field: { name?: string }) => field?.name === 'site'))
        .map((collection) => collection.slug)

      expect(unscoped).toEqual([])
    })
  })

  describe('checkout', () => {
    it('prices the order from the product row, never from the body', async () => {
      const response = await post({
        body: {
          // Both of these are lies, and both are ignored.
          price: 1,
          product: tracked.id,
          quantity: 2,
          total: 1,
          name: 'سارا',
          phone: '۰۹۱۲۱۲۳۴۵۶۷',
        },
        host: 'shop.localhost',
      })

      expect(response.status).toBe(200)

      const order = await orderFor(response)

      expect(order.total).toBe(480_000 * 2)
      expect(order.unitPrice).toBe(480_000)
      expect(order.quantity).toBe(2)
      expect(order.currency).toBe('IRT')
      expect(order.status).toBe('pending')
      // Normalised from Persian-Indic digits, because that is what a Persian keyboard
      // types and `tel:` cannot dial ۰۹۱۲.
      expect(order.buyer?.phone).toBe('09121234567')
    })

    it('attributes the order to the Host’s site, not to the site named in the body', async () => {
      const response = await post({
        body: {
          name: 'سارا',
          phone: '09121234567',
          product: tracked.id,
          quantity: 1,
          // The form-submissions hole, in a place where money follows.
          site: acme.id,
        },
        host: 'shop.localhost',
      })

      const order = await orderFor(response)

      expect(idOf(order.site)).toBe(String(shop.id))
    })

    it('refuses a product that is another site’s or still a draft, and writes nothing', async () => {
      for (const id of [foreign.id, draft.id]) {
        const response = await post({
          body: { name: 'سارا', phone: '09121234567', product: id },
          host: 'shop.localhost',
        })

        expect(response.status).toBe(409)
        // Deliberately not "not published" versus "not yours": the answer is the same
        // either way, so the endpoint is not a way to probe another tenant's ids.
        expect(await response.json()).toMatchObject({ ok: false })
      }

      // Scoped to the two products these attempts named — other tests in this file
      // legitimately bought the *buyable* one under the same buyer name.
      const { totalDocs } = await payload.count({
        collection: 'orders',
        overrideAccess: true,
        where: {
          and: [{ 'buyer.name': { equals: 'سارا' } }, { product: { in: [foreign.id, draft.id] } }],
        },
      })

      expect(totalDocs).toBe(0)
    })

    it('refuses more than the stock and leaves the count alone', async () => {
      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id, quantity: 5 },
        host: 'shop.localhost',
      })

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ available: 2, ok: false })

      expect((await product({ id: { equals: tracked.id } })).inventory).toBe(2)
    })

    it('writes nothing for the honeypot and does not say so', async () => {
      const response = await post({
        body: {
          company: 'SEO stuff',
          name: 'ربات',
          phone: '09121234567',
          product: tracked.id,
        },
        host: 'shop.localhost',
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true })

      const { docs } = await payload.find({
        collection: 'orders',
        overrideAccess: true,
        where: { 'buyer.name': { equals: 'ربات' } },
      })

      expect(docs).toHaveLength(0)
    })

    it('throttles repeated purchases from one client', async () => {
      process.env.CHECKOUT_RATE_LIMIT = '2'

      resetRateLimits()

      const body = { name: 'سارا', phone: '09121234567', product: tracked.id }

      const first = await post({ body, host: 'shop.localhost' })
      const second = await post({ body, host: 'shop.localhost' })
      const third = await post({ body, host: 'shop.localhost' })

      expect(first.status).toBeLessThan(400)
      expect(second.status).toBeLessThan(400)
      expect(third.status).toBe(429)
      expect(third.headers.get('retry-after')).toBeTruthy()
    })

    it('refuses a second identical pending order from the same phone', async () => {
      process.env.CHECKOUT_DUPLICATE_WINDOW_MINUTES = '15'

      // A phone of its own per run, so a previous run's still-pending order cannot make
      // this one pass by accident. `afterAll` deletes them by buyer name.
      const body = {
        name: 'سارا',
        phone: `0912${String(Date.now()).slice(-7)}`,
        product: tracked.id,
      }

      const first = await post({ body, host: 'shop.localhost' })
      const second = await post({ body, host: 'shop.localhost' })
      const refusal = await second.json()

      expect(first.status).toBe(200)
      expect(second.status).toBe(409)
      expect(refusal).toMatchObject({ ok: false })

      // …and the refusal is not a leak: no receipt URL for the existing order comes
      // back, because the link *is* the capability to read that order.
      expect(JSON.stringify(refusal)).not.toContain('checkout/')

      // A different product on the same phone is a different order, not a duplicate.
      const other = await post({
        body: { ...body, product: (await product({ title: { equals: 'زعفران سرگل' } })).id },
        host: 'shop.localhost',
      })

      expect(other.status).toBe(200)
    })

    it('refuses a host that belongs to no site', async () => {
      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id },
        host: 'nobody.localhost',
      })

      expect(response.status).toBe(400)
    })

    it('leaves a card-to-card order pending, because nothing can confirm it', async () => {
      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id },
        host: 'shop.localhost',
      })

      const order = await orderFor(response)

      const returned = await get(`/api/checkout/callback?order=${order.id}&status=ok`, 'shop.localhost')

      // A browser return is a redirect to the receipt page, not a JSON answer.
      expect(returned.status).toBe(302)
      expect((await orderById(order.id)).status).toBe('pending')
      // `status=ok` in a query string is a claim, not a payment.
      expect((await product({ id: { equals: tracked.id } })).inventory).toBe(2)
    })

    it('hands an unknown order id to no one and a foreign site’s id to no one', async () => {
      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id },
        host: 'shop.localhost',
      })

      const order = await orderFor(response)

      // Same order id, asked from the *other* tenant's domain.
      const crossHost = await get(`/api/checkout/callback?order=${order.id}&status=ok`, 'acme.localhost')

      expect(crossHost.status).toBe(400)
      expect(await readOrderDocs(payload, order.id, String(acme.id))).toBeNull()
    })
  })

  describe('receipt link', () => {
    it('opens only with a signature over this order and this site', async () => {
      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id },
        host: 'shop.localhost',
      })

      const { id } = await orderFor(response)
      const receipt = signOrderReceipt({ orderId: id, siteId: String(shop.id) })

      expect(verifyOrderReceipt({ orderId: id, receipt, siteId: String(shop.id) })).toBe(true)
      expect(verifyOrderReceipt({ orderId: id, receipt: `${receipt}x`, siteId: String(shop.id) })).toBe(false)
      // Same signature, another tenant: the site is part of what is signed, so a
      // leaked link cannot be replayed on a different domain.
      expect(verifyOrderReceipt({ orderId: id, receipt, siteId: String(acme.id) })).toBe(false)

      const own = await readOrderDocs(payload, id, String(shop.id))

      expect(own?.order.id).toBe(id)
      expect(await readOrderDocs(payload, id, String(acme.id))).toBeNull()
    })
  })

  describe('http gateway', () => {
    let gateway: GatewayCalls
    let server: Server

    beforeAll(async () => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = []

        req.on('data', (chunk) => chunks.push(chunk as Buffer))
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')

          gateway.calls.push({ body, url: req.url ?? '' })

          res.setHeader('content-type', 'application/json')

          if (req.url === '/create') {
            res.end(JSON.stringify({ redirectUrl: 'https://psp.test/pay/abc', reference: 'PSP-1' }))

            return
          }

          // The verify endpoint is the only thing that can turn an order paid — and
          // it is driven by the *amount we stored*, not by anything the buyer sent.
          const ok = body.amount === 960_000 && body.reference === 'PSP-1'

          res.end(JSON.stringify({ ok, reference: 'PSP-2' }))
        })
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

      const port = (server.address() as { port: number }).port

      process.env.PAYMENT_HTTP_CREATE_URL = `http://127.0.0.1:${port}/create`
      process.env.PAYMENT_HTTP_VERIFY_URL = `http://127.0.0.1:${port}/verify`
      process.env.PAYMENT_HTTP_TOKEN = 'test-token'
    })

    afterAll(async () => {
      delete process.env.PAYMENT_HTTP_CREATE_URL
      delete process.env.PAYMENT_HTTP_VERIFY_URL
      delete process.env.PAYMENT_HTTP_TOKEN

      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    })

    beforeEach(() => {
      gateway = { calls: [] }
    })

    it('sends the buyer to the gateway and keeps only what identifies the attempt', async () => {
      await setStoreSettings({ currency: 'IRT', paymentProvider: 'http' })

      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id, quantity: 2 },
        host: 'shop.localhost',
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, redirectUrl: 'https://psp.test/pay/abc' })

      const [call] = gateway.calls

      expect(call.url).toBe('/create')
      // The amount the store decided, in the site's minor unit — and the callback URL
      // is on the *customer's* host, since that is how the tenant is resolved back.
      expect(call.body.amount).toBe(960_000)
      expect(call.body.currency).toBe('IRT')
      expect(call.body.callbackUrl).toContain('shop.localhost/api/checkout/callback?order=')
    })

    it('marks the order paid, settles stock once, and is idempotent', async () => {
      await setStoreSettings({ currency: 'IRT', paymentProvider: 'http' })

      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id, quantity: 2 },
        host: 'shop.localhost',
      })

      const { id } = await orderFor(response)

      // A callback that carries nothing worth trusting: `status=ok` is not even read.
      const settled = await callback(`/api/checkout/callback?order=${id}`, { status: 'ok' })

      expect(settled.status).toBe(200)

      const paid = await orderById(id)

      expect(paid.status).toBe('paid')
      expect(paid.payment?.reference).toBe('PSP-2')
      expect(paid.payment?.paidAt).toBeTruthy()
      expect((await product({ id: { equals: tracked.id } })).inventory).toBe(0)

      // Same callback, delivered twice — which is what a PSP retry is.
      await callback(`/api/checkout/callback?order=${id}`)

      expect((await orderById(id)).status).toBe('paid')
      expect((await product({ id: { equals: tracked.id } })).inventory).toBe(0)
      // One verify call for the first callback, none for the retry: it short-circuits
      // on `paid` instead of going back to the gateway.
      expect(gateway.calls.filter((call) => call.url === '/verify')).toHaveLength(1)
    })

    it('does not mark an order paid when the gateway refuses', async () => {
      await setStoreSettings({ currency: 'IRT', paymentProvider: 'http' })

      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id, quantity: 1 },
        host: 'shop.localhost',
      })

      const { id } = await orderFor(response)

      // Wrong amount on the gateway side — the mock only accepts 960000, this order is
      // 480000 — so verification says no.
      const refused = await callback(`/api/checkout/callback?order=${id}`)

      expect(refused.status).toBe(409)
      expect((await orderById(id)).status).toBe('pending')
      expect((await product({ id: { equals: tracked.id } })).inventory).toBe(2)
    })

    it('fails with 503 and a stored pending order when the gateway is not configured', async () => {
      const urls = [
        process.env.PAYMENT_HTTP_CREATE_URL,
        process.env.PAYMENT_HTTP_VERIFY_URL,
        process.env.PAYMENT_HTTP_TOKEN,
      ]

      delete process.env.PAYMENT_HTTP_CREATE_URL
      delete process.env.PAYMENT_HTTP_VERIFY_URL
      delete process.env.PAYMENT_HTTP_TOKEN

      await setStoreSettings({ currency: 'IRT', paymentProvider: 'http' })

      const response = await post({
        body: { name: 'سارا', phone: '09121234567', product: tracked.id },
        host: 'shop.localhost',
      })

      expect(response.status).toBe(503)

      // Read once: a `Response` body is a stream, and `orderFor()` would be reading
      // the same one a second time.
      const body = (await response.json()) as { confirmationUrl?: string; message?: string; pending?: boolean }

      expect(body).toMatchObject({
        message: 'درگاه پرداخت این سایت پیکربندی نشده است.',
        pending: true,
      })

      // The buyer still has a page to go to, and the owner still has the order.
      expect(typeof body.confirmationUrl).toBe('string')

      const pendingId = body.confirmationUrl?.match(/checkout\/([^?]+)/)?.[1]

      expect(pendingId).toBeTruthy()
      expect((await orderById(String(pendingId))).status).toBe('pending')

      process.env.PAYMENT_HTTP_CREATE_URL = urls[0]
      process.env.PAYMENT_HTTP_VERIFY_URL = urls[1]
      process.env.PAYMENT_HTTP_TOKEN = urls[2]
    })
  })

  // ---- helpers used by the describes above ------------------------------------

  async function orderFor(response: Response): Promise<Order> {
    const body = (await response.json()) as { confirmationUrl?: string }

    expect(body.confirmationUrl, 'the response carries the receipt URL').toBeTruthy()

    const id = body.confirmationUrl?.match(/checkout\/([^?]+)/)?.[1]

    if (!id) throw new Error(`no order id in ${body.confirmationUrl}`)

    return orderById(id)
  }

  const orderById = async (id: string): Promise<Order> => {
    const doc = await payload.findByID({
      collection: 'orders',
      depth: 0,
      id,
      overrideAccess: true,
    })

    return doc as Order
  }

  const post = (args: { body?: unknown; host: string; path?: string }) =>
    request({ ...args, path: args.path ?? '/api/checkout' }).then(startCheckout)

  /** The gateway's own POST, from its server rather than from a browser. */
  const callback = (path: string, body?: unknown, host = 'shop.localhost') =>
    request({ body, host, method: 'POST', path }).then(completeCheckout)

  const get = (path: string, host: string) =>
    request({ host, method: 'GET', path }).then(completeCheckout)

  /**
   * Only `currency` and `paymentProvider` are written — the localized
   * `paymentInstructions` is left exactly as the seed wrote it, both so the suite
   * cannot overwrite what it asserts about the seed and because Payload writes a
   * localized field in the request's locale (no locale here means the write would
   * land somewhere the storefront does not read).
   */
  async function setStoreSettings(settings: {
    currency?: CurrencyCode
    paymentProvider: PaymentProviderName
  }) {
    const { docs } = await payload.find({
      collection: 'store',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: shop.id } },
    })

    const data = {
      currency: settings.currency ?? 'IRT',
      paymentProvider: settings.paymentProvider,
      site: shop.id,
    }

    return docs[0]
      ? payload.update({ id: docs[0].id, collection: 'store', data, overrideAccess: true })
      : payload.create({ collection: 'store', data, overrideAccess: true })
  }
})

type GatewayCalls = { calls: { body: Record<string, unknown>; url: string }[] }
