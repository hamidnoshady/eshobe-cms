import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import type { CheckoutOrder } from '@/payments'
import type { Order, Product, Site } from '@/payload-types'

import { newOrderReference } from '@/collections/hooks/snapshotOrder'
import { toAsciiDigits } from '@/lib/digits'
import { MAX_ORDER_QUANTITY } from '@/lib/checkout'
import { isUuid } from '@/lib/ids'
import { localeHref } from '@/lib/locales'
import { readOrderDocs, signOrderReceipt } from '@/lib/order-receipt'
import { findForSite, siteFromRequest } from '@/lib/site-query'
import { storeSettingsForSite } from '@/lib/store'
import { PaymentGatewayNotConfigured, resolvePaymentProvider } from '@/payments'

/**
 * The storefront's two halves of a purchase.
 *
 * Payload endpoints rather than Next route handlers: this writes tenant-scoped
 * collections and Payload already owns that machinery — `overrideAccess`, the tenant
 * filter on relationship writes, the same validation the admin runs. A route handler
 * would re-implement the first and get the second wrong.
 *
 * ## The rule both halves obey
 *
 * The site comes from the `Host` header. Not from the body, not from a query
 * parameter, not from the product id. This is the same hole the form builder's
 * submissions had (see `src/plugins/index.ts`): public create access plus a tenant
 * field the caller may fill in is an endpoint where anyone decides which customer's
 * rows grow. Here there is money on the other end, so the response gives no clue
 * about the site either — a foreign or draft `productId` is simply "not purchasable".
 *
 * ## Reachability
 *
 * `/api` is blocked on customer domains by Caddy (Wave 4) except for a short list of
 * carve-outs; `/api/checkout*` is one of them (`Caddyfile`), because the buyer's
 * browser posts it from their own domain.
 */

const noStore = { 'cache-control': 'no-store' }

/**
 * `req.query` is what the REST handler fills in; `req.url` is what exists on a
 * request built by `createLocalReq` (and on any Request, really). Reading both costs
 * one line and means the callback can be driven from a test, a PSP, or a browser
 * without caring which of the two Payload happened to populate.
 */
const queryParam = (req: PayloadRequest, name: string): null | string => {
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.[name]

  if (typeof fromQuery === 'string') return fromQuery

  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams.get(name)
  } catch {
    return null
  }
}

const badRequest = (message: string) =>
  Response.json({ message }, { headers: noStore, status: 400 })

/**
 * Buyer-facing copy is Persian first (CLAUDE.md) and never more specific than "that
 * did not work": a checkout endpoint is a free probe for whoever is guessing product
 * ids, and "not found" versus "not published" is the difference between two guesses
 * and a catalogue dump.
 */
const refused = (req: PayloadRequest, reason: string, status = 409) => {
  req.payload.logger.warn({ msg: `checkout: ${reason}` })

  return Response.json(
    { message: 'این خرید هم‌اکنون ممکن نیست. لطفاً دوباره تلاش کنید.', ok: false },
    { headers: noStore, status },
  )
}

/**
 * Normalise, don't reject. A phone number typed on a Persian keyboard is the same
 * number; refusing ۰۹۱۲… because it is not ASCII is a broken form, not a security
 * win. The shape is checked once, here, and the stored value is the normalised one.
 */
const normalizePhone = (value: unknown): null | string => {
  if (typeof value !== 'string') return null

  const digits = toAsciiDigits(value).replace(/\D/g, '')

  return /^0?9\d{9}$/.test(digits) ? digits : null
}

/**
 * The buyer's own link. Relative, so it stays on the domain they came from, and
 * prefixed through `localeHref` — the site's default locale has no segment, so an
 * English-default store gets `/checkout/…` and not a duplicate `/en/checkout/…`.
 */
const confirmationUrl = ({
  locale,
  orderId,
  site,
  siteId,
}: {
  locale: string
  orderId: string
  site: Site
  siteId: string
}) =>
  `${localeHref(`/checkout/${orderId}`, locale, site.defaultLocale)}?r=${encodeURIComponent(
    signOrderReceipt({ orderId, siteId }),
  )}`

/** What a provider is told about a payment, and nothing more. */
const toCheckoutOrder = ({ locale, order, site }: { locale: string; order: Order; site: Site }): CheckoutOrder => ({
  buyer: {
    email: order.buyer?.email ?? undefined,
    name: order.buyer?.name ?? '',
    phone: order.buyer?.phone ?? '',
  },
  currency: order.currency,
  id: String(order.id),
  locale,
  productTitle: order.productTitle ?? '',
  quantity: Number(order.quantity ?? 1),
  reference: String(order.reference ?? order.id),
  site,
  total: Number(order.total ?? 0),
})

export const startCheckout: Endpoint['handler'] = async (req) => {
  await addDataAndFileToRequest(req)

  const data = (req.data ?? {}) as Record<string, unknown>

  // Honeypot: a field no human sees, so a dumb bot fills it. Answer as if it worked
  // and write nothing — reporting a failure is how a scraper learns to drop the field.
  if (typeof data.company === 'string' && data.company.trim()) {
    return Response.json({ message: 'ثبت شد.', ok: true })
  }

  const site = await siteFromRequest(req)

  if (!site) return badRequest('unknown host')

  const productId = typeof data.product === 'string' ? data.product : null

  if (!isUuid(productId)) return badRequest('product id missing or malformed')

  const quantity = Number(data.quantity ?? 1)

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) {
    return badRequest('quantity out of range')
  }

  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const phone = normalizePhone(data.phone)
  const email = typeof data.email === 'string' && data.email.includes('@') ? data.email.trim() : ''
  const note = typeof data.note === 'string' ? data.note.trim().slice(0, 500) : ''

  if (!name || name.length > 200 || !phone) return badRequest('buyer details missing or invalid')

  // Absent, never `undefined`: Payload's generated create-data types reject an
  // explicit `undefined` on an optional field, and `{ email: '' }` would store an
  // empty string as if it were an address.
  const buyer = { name, phone, ...(email ? { email } : {}), ...(note ? { note } : {}) }

  // `findForSite`, so the product is access-controlled *and* tenant-scoped in one
  // call: a draft, an unpublished, or another site's product is not readable here,
  // and no price for any of them is ever revealed.
  const { docs } = await findForSite('products', String(site.id), {
    depth: 0,
    limit: 1,
    locale: site.defaultLocale ?? undefined,
    pagination: false,
    where: { id: { equals: productId } },
  })

  const product = docs[0] as Product | undefined

  if (!product) return refused(req, `product ${productId} not purchasable on ${site.domain}`)

  if (product.trackInventory && typeof product.inventory === 'number') {
    if (product.inventory < quantity) {
      return Response.json(
        {
          available: product.inventory,
          message:
            product.inventory === 0
              ? 'این محصول تمام شده است.'
              : `تنها ${product.inventory} عدد از این محصول موجود است.`,
          ok: false,
        },
        { headers: noStore, status: 409 },
      )
    }
  }

  // Every number comes from the row just read. A body carrying `total: 1` buys
  // nothing at that price, because the client is not asked what the price is.
  const unitPrice = Number(product.price ?? 0)

  if (!Number.isInteger(unitPrice) || unitPrice < 1) {
    return refused(req, `product ${productId} has no usable price`)
  }

  const { currency, paymentProvider } = await storeSettingsForSite(String(site.id), {
    locale: site.defaultLocale ?? undefined,
  })

  const provider = resolvePaymentProvider(paymentProvider)
  const total = unitPrice * quantity
  const locale = site.defaultLocale ?? 'fa'

  const order = await req.payload.create({
    collection: 'orders',
    data: {
      buyer,
      currency,
      payment: { provider: provider.name },
      reference: newOrderReference(),
      product: product.id,
      quantity,
      // The tenant, from the Host — see the header comment.
      site: site.id,
      status: 'pending',
      total,
      unitPrice,
    },
    depth: 0,
    // The collection's own `create` is staff-only on purpose, so that anonymous REST
    // writes to an orders table are impossible. This is the one sanctioned door: the
    // tenant is resolved, the price is computed, and the buyer's details are validated.
    overrideAccess: true,
    req,
  })

  const checkoutOrder = toCheckoutOrder({ locale, order, site })

  let redirectUrl: null | string = null
  let paymentReference: string | undefined

  try {
    const initiation = await provider.initiate({ order: checkoutOrder, req })

    redirectUrl = initiation.redirectUrl ?? null
    paymentReference = initiation.paymentReference
  } catch (error) {
    // The order stands as `pending`: an owner can still complete it by hand, and an
    // attempt that reached the gateway and then failed must stay findable.
    req.payload.logger.error({
      err: error as Error,
      msg: `checkout: initiate failed for order ${order.id}`,
    })

    return Response.json(
      {
        confirmationUrl: confirmationUrl({ locale, orderId: String(order.id), site, siteId: String(site.id) }),
        message:
          error instanceof PaymentGatewayNotConfigured
            ? 'درگاه پرداخت این سایت پیکربندی نشده است.'
            : 'درگاه پرداخت پاسخ نداد؛ سفارش شما ذخیره شد.',
        ok: true,
        pending: true,
      },
      { headers: noStore, status: 503 },
    )
  }

  if (paymentReference) {
    await req.payload.update({
      id: order.id,
      collection: 'orders',
      data: { payment: { provider: provider.name, reference: paymentReference } },
      depth: 0,
      overrideAccess: true,
      req,
    })
  }

  return Response.json(
    {
      confirmationUrl: confirmationUrl({ locale, orderId: String(order.id), site, siteId: String(site.id) }),
      ok: true,
      redirectUrl,
    },
    { headers: noStore },
  )
}

/**
 * The second half: the buyer or the gateway comes back, and an order is marked paid
 * only after the provider itself says so, server to server.
 *
 * `?order=` is the only client-supplied fact used, and even that is re-read scoped to
 * the site from the `Host`. `status=ok` in a query string proves nothing about
 * anything.
 */
export const completeCheckout: Endpoint['handler'] = async (req) => {
  const orderId = queryParam(req, 'order')
  const isBrowser = req.method === 'GET'

  if (!isUuid(orderId)) {
    return badRequest('order id missing or malformed')
  }

  const site = await siteFromRequest(req)

  if (!site) return badRequest('unknown host')

  const found = await readOrderDocs(req.payload, String(orderId), String(site.id))

  if (!found) return badRequest('order not found on this site')

  const { order } = found
  const locale = site.defaultLocale ?? 'fa'
  const back = confirmationUrl({ locale, orderId: String(order.id), site, siteId: String(site.id) })

  // Idempotent: a gateway retrying its callback, or a buyer refreshing the return
  // URL, must not pay twice, move the order backwards, or settle the stock again.
  if (order.status === 'paid') {
    return isBrowser ? redirect(back) : Response.json({ ok: true, status: order.status }, { headers: noStore })
  }

  const provider = resolvePaymentProvider(order.payment?.provider)

  if (!provider.confirm) {
    // Card to card has nothing to ask. The order waits for the store owner, who
    // settles stock by moving the status in the admin.
    const message = 'سفارش شما ثبت شد؛ پس از واریز، فروشگاه آن را تأیید می‌کند.'

    return isBrowser
      ? redirect(back)
      : Response.json({ message, ok: true, status: order.status }, { headers: noStore })
  }

  const confirmation = await provider.confirm({
    order: toCheckoutOrder({ locale, order, site }),
    // What we stored at initiate — not what the query string claims.
    paymentReference: order.payment?.reference ?? undefined,
    req,
  })

  if (!confirmation.ok) {
    const message = confirmation.reason ?? 'پرداخت تأیید نشد.'

    return isBrowser
      ? redirect(`${back}&m=failed`)
      : Response.json({ message, ok: false, status: order.status }, { headers: noStore, status: 409 })
  }

  const paid = await req.payload.update({
    id: order.id,
    collection: 'orders',
    data: {
      payment: {
        paidAt: new Date().toISOString(),
        provider: provider.name,
        reference: confirmation.paymentReference ?? order.payment?.reference,
      },
      status: 'paid',
    },
    depth: 0,
    // The provider verified the money and the order is already this site's, by the
    // read above. A gateway callback has no user to authorise against.
    overrideAccess: true,
    req,
  })

  return isBrowser
    ? redirect(back)
    : Response.json({ ok: true, status: paid.status }, { headers: noStore })
}

const redirect = (location: string): Response =>
  new Response(null, { headers: { ...noStore, location }, status: 302 })

export const checkoutEndpoints: Endpoint[] = [
  { handler: startCheckout, method: 'post', path: '/checkout' },
  // GET is the browser returning from the gateway, POST the gateway's own callback:
  // same verification, different answer — a browser needs a URL, a PSP needs a 2xx
  // or it retries.
  { handler: completeCheckout, method: 'get', path: '/checkout/callback' },
  { handler: completeCheckout, method: 'post', path: '/checkout/callback' },
]
