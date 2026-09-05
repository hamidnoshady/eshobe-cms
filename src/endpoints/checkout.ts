import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import type { PaymentProvider } from '@/payments'
import type { Product, Site } from '@/payload-types'

import { isGatewayId, listEnabledGateways, verifyGatewayState } from '@/payments/gateways'

import { newOrderReference } from '@/collections/hooks/snapshotOrder'
import { toAsciiDigits } from '@/lib/digits'
import { clientKey, consume } from '@/lib/rate-limit'
import { MAX_ORDER_QUANTITY, toCheckoutOrder } from '@/lib/checkout'
import { isUuid } from '@/lib/ids'
import { localeHref } from '@/lib/locales'
import { CHECKOUT_BASE } from '@/lib/slug'
import { readOrderDocs, signOrderReceipt } from '@/lib/order-receipt'
import { findForSite, siteFromRequest } from '@/lib/site-query'
import { sendOrderReceipt } from '@/lib/order-email'
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

/**
 * Purchases per IP per window, per site. Env-tunable because the honest number for a
 * shop with 40 customers an hour and a bot with a script are different, and a limit that
 * cannot be raised without a deploy is a limit that gets removed under pressure.
 */
const rateLimit = () => ({
  limit: Number(process.env.CHECKOUT_RATE_LIMIT ?? 20),
  windowMs: Number(process.env.CHECKOUT_RATE_LIMIT_WINDOW_MS ?? 10 * 60_000),
})

/**
 * How long one phone number may hold a second identical order at bay.
 *
 * The rate limit above is per IP and an attacker rotates IPs; this one is keyed on the
 * only buyer identifier a store can rely on (Iranian storefronts rarely require an
 * account, see WAVE-9.md §4) and it is what actually stops a script from filling the
 * orders table with `pending` rows. It is a duplicate *refusal*, not a duplicate
 * redirect: handing back the existing order's receipt URL would make this endpoint an
 * oracle for anyone who can guess a phone number, and a receipt link is the capability
 * that reveals an order.
 */
/**
 * Read per call, not at module load: these numbers have to be movable without a
 * restart for the tests that exercise the guards, and an env var captured at import
 * time is a silently frozen one.
 */
const duplicateWindowMs = () =>
  Number(process.env.CHECKOUT_DUPLICATE_WINDOW_MINUTES ?? 15) * 60_000

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

/**
 * `req.query` is populated by Payload's REST layer; `req.url` always exists. Adapters that
 * read a callback parameter (`authority`, `trackingCode`, `providerId`) get both merged, so
 * the same handler works whether a PSP posted a form, posted JSON, or bounced a browser.
 */
const bodyQuery = (req: PayloadRequest): null | Record<string, string> => {
  try {
    return Object.fromEntries(new URL(req.url ?? '', 'http://localhost').searchParams.entries())
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
  `${localeHref(`${CHECKOUT_BASE}/${orderId}`, locale, site.defaultLocale)}?r=${encodeURIComponent(
    signOrderReceipt({ orderId, siteId }),
  )}`

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

  // Before any database work: the point of the throttle is to make a spray cheap to
  // refuse, and a check after the reads has spent the money it was meant to save.
  const limit = consume({
    key: `checkout:${site.id}:${clientKey(req.headers)}`,
    ...rateLimit(),
  })

  if (!limit.allowed) {
    req.payload.logger.warn({ msg: `checkout: rate limited on ${site.domain}` })

    return Response.json(
      { message: 'چند لحظه صبر کنید و دوباره تلاش کنید.', ok: false },
      {
        headers: { ...noStore, 'retry-after': String(limit.retryAfterSeconds) },
        status: 429,
      },
    )
  }

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

  const duplicateWindow = duplicateWindowMs()

  if (duplicateWindow > 0) {
    const { totalDocs: alreadyPending } = await req.payload.count({
      collection: 'orders',
      overrideAccess: true,
      req,
      where: {
        and: [
          { createdAt: { greater_than: new Date(Date.now() - duplicateWindow).toISOString() } },
          { 'buyer.phone': { equals: phone } },
          { product: { equals: product.id } },
          { site: { equals: site.id } },
          { status: { equals: 'pending' } },
        ],
      },
    })

    if (alreadyPending > 0) {
      return Response.json(
        {
          message:
            'شما همین حالا یک سفارش در انتظار پرداخت دارید. اگر لینک تأیید را ندارید، با فروشگاه تماس بگیرید.',
          ok: false,
        },
        { headers: noStore, status: 409 },
      )
    }
  }

  const { currency, paymentProvider } = await storeSettingsForSite(String(site.id), {
    locale: site.defaultLocale ?? undefined,
  })

  const total = unitPrice * quantity
  const locale = site.defaultLocale ?? 'fa'

  /**
   * Which gateway takes this order — the buyer's choice, or the site's.
   *
   * Resolved *before* the order is created, so a stale picker cannot leave a `pending`
   * row behind that the duplicate guard will then hold against the buyer for fifteen
   * minutes. `listEnabledGateways` answers it without decrypting anything: a gateway the
   * site has not switched on, has not configured, or whose amount window excludes this
   * basket is simply not in the list.
   */
  const requested = typeof data.gateway === 'string' && data.gateway.trim() ? data.gateway.trim() : null

  if (requested !== null && !isGatewayId(requested)) return badRequest('unknown gateway')

  const methods = await listEnabledGateways({
    amount: total,
    currency,
    req,
    siteId: String(site.id),
  })

  let provider: PaymentProvider

  if (requested) {
    const method = methods.find(({ id }) => id === requested)

    if (!method) {
      // Telling the buyer *why* is safe here for the same reason `/api/payments/methods`
      // is public: which gateways this site has switched on is already readable from its
      // own domain. The reasons come from `resolveGateway` and are deliberately coarse —
      // "unavailable" and "amount out of range", never "misconfigured".
      const refusal =
        methods.length === 0
          ? 'پرداخت آنلاین در حال حاضر برای این فروشگاه فعال نیست.'
          : 'این روش پرداخت برای مبلغ سفارش شما در دسترس نیست. روش دیگری را انتخاب کنید.'

      return Response.json({ message: refusal, methods, ok: false }, { headers: noStore, status: 409 })
    }

    provider = resolvePaymentProvider(method.id)
  } else if (methods.length > 0 && !isGatewayId(paymentProvider ?? undefined)) {
    /**
     * The site's configured method is a *method* (`bank`, `http`) but it has switched a
     * gateway on. Switching one on is an explicit statement of intent — "take money this
     * way" — and `store.paymentProvider` is a default most tenants never visit, so the
     * top-priority enabled gateway wins. A headless renderer that has not been updated to
     * send `gateway` therefore gets the merchant's new PSP instead of silently falling
     * back to card-to-card, and the storefront picker still overrides this per buyer.
     */
    provider = resolvePaymentProvider(methods[0]?.id ?? paymentProvider)
  } else {
    provider = resolvePaymentProvider(paymentProvider)
  }

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
  let initiation: Awaited<ReturnType<NonNullable<PaymentProvider['initiate']>>> | undefined

  try {
    initiation = await provider.initiate({ order: checkoutOrder, req })

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
            ? // `detail` is a `resolveGateway` refusal reason: written to be shown to a
              // buyer, so it names what is unavailable without naming what is missing.
              (error.detail ?? 'درگاه پرداخت این سایت پیکربندی نشده است.')
            : 'درگاه پرداخت پاسخ نداد؛ سفارش شما ذخیره شد.',
        ok: true,
        pending: true,
      },
      { headers: noStore, status: 503 },
    )
  }

  /**
   * Everything the attempt produced, in one write: the reference the callback will look
   * up, the environment it was taken in, and whatever the PSP handed back that a support
   * conversation will need (a ticket, a token, a fee).
   *
   * `gatewayData` is written here and nowhere else by a caller — the column denies writes
   * at field level, and this update runs `overrideAccess`, because it is the adapter's
   * account of what the PSP said rather than a tenant's opinion of it.
   */
  if (paymentReference || initiation?.data || initiation?.mode) {
    await req.payload.update({
      id: order.id,
      collection: 'orders',
      data: {
        payment: {
          ...(initiation?.data ? { gatewayData: initiation.data } : {}),
          ...(initiation?.mode ? { mode: initiation.mode } : {}),
          provider: provider.name,
          ...(paymentReference ? { reference: paymentReference } : {}),
        },
      },
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
  // A PSP's own callback is a POST with a body, and every adapter that cross-checks one
  // (`amount`, `providerId`, `reference`) reads it from `callback.body`. Payload fills
  // `req.data` only when asked to.
  await addDataAndFileToRequest(req)

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

  /**
   * The signed state we put on the callback URL, checked before anything else.
   *
   * Not a substitute for asking the gateway — `confirm` does that, and `verifyGatewayState`
   * failing still leaves the order untouched rather than paid. What it does close is a
   * narrower hole: `/api/checkout/callback?order=<uuid>` with no `st` is reachable by
   * anyone who learns an order id, and without this an attacker can drive the callback for
   * an order they did not create, forcing a verify against the PSP with whatever
   * `providerId`/`authority` they like to supply. Refusing an unknown or replayed signature
   * costs nothing — the URL we hand the PSP carries a fresh one, good for fifteen minutes
   * and one order.
   *
   * A `gw` that disagrees with the order's own provider is refused outright: it means the
   * URL was edited, and the stored provider is the only one this attempt was ever made
   * against.
   */
  const state = queryParam(req, 'st')
  const claimedGateway = queryParam(req, 'gw')

  if (claimedGateway && claimedGateway !== order.payment?.provider) {
    return refused(req, `callback: gateway ${claimedGateway} does not match order ${order.id}`, 400)
  }

  if (
    state &&
    !verifyGatewayState(state, {
      amount: Number(order.total ?? 0),
      gateway: String(order.payment?.provider ?? ''),
      orderId: String(order.id),
      siteId: String(site.id),
    })
  ) {
    return refused(req, `callback: bad or expired state signature for order ${order.id}`, 400)
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
    /**
     * What came back, for lookups and cross-checks only. `paymentReference` below is what
     * we stored at initiate — never what the query string claims — and the adapters that
     * read `callback` (Digipay's `providerId`, ZarinPal's `authority`) compare it against
     * the stored value before believing it.
     */
    callback: {
      body: (req.data ?? {}) as Record<string, unknown>,
      query: { ...(req.query as Record<string, unknown>), ...(bodyQuery(req) ?? {}) },
    },
    order: toCheckoutOrder({ locale, order, site }),
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
        ...(confirmation.data ? { gatewayData: confirmation.data } : {}),
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

  // After the write, not before: the receipt must not promise a payment the status
  // does not yet record. And never allowed to fail the response — see
  // `src/lib/order-email.ts`.
  await sendOrderReceipt({ locale, order: paid, req, site }).catch((error: unknown) => {
    req.payload.logger.error({
      err: error as Error,
      msg: `order receipt email failed for order ${order.id}`,
    })
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
