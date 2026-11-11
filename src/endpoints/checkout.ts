import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest, ValidationError } from 'payload'

import type { PaymentProvider } from '@/payments'
import type { Coupon, Order, Product, Site } from '@/payload-types'

import { isGatewayId, listEnabledGateways, verifyGatewayState } from '@/payments/gateways'

import { newOrderReference } from '@/collections/hooks/snapshotOrder'
import {
  cartFingerprint,
  COUNTER_PROVIDER,
  isCafeCheckout,
  isCheckoutRequestId,
  isPaymentChoice,
  refuseServiceMode,
  type PaymentChoice,
  type ServiceMode,
} from '@/lib/cafe-order'
import { toAsciiDigits } from '@/lib/digits'
import { resolveModifiers } from '@/lib/cafe-menu'
import { withDerivedSiteWrite } from '@/lib/derived-site-write'
import { clientKey, consume } from '@/lib/rate-limit'
import { MAX_ORDER_QUANTITY, toCheckoutOrder } from '@/lib/checkout'
import { isUuid } from '@/lib/ids'
import { isLocale, localeHref } from '@/lib/locales'
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
 *
 * ## Café orders (ESH-150)
 *
 * A request carrying any café field (`serviceMode`, `tableToken`, `paymentChoice`,
 * `checkoutRequestId`) is a café order and gets the café rules: dine-in needs an opaque
 * Biza table token, takeaway must not carry one, pay-at-counter creates an unpaid order
 * without touching a gateway, and the whole request is idempotent on
 * (request id, cart fingerprint). A request carrying none of them is the legacy
 * storefront and runs the code it always ran — see `src/lib/cafe-order.ts` for the
 * vocabulary and the policies those rules are written against.
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
 * A café refusal has a *reason the guest can act on* — «این میز شناسایی نشد، QR را
 * دوباره اسکن کنید» — because the failure is almost always a stale QR code or a table
 * closed by staff, and a generic error sends them to the counter to ask.
 *
 * The wording is still deliberately coarse for anything that could be probed: an invalid
 * token and a token from another tenant answer identically, and the detail goes to the
 * log.
 */
const refusedCafe = (req: PayloadRequest, reason: string, message: string, status = 400) => {
  req.payload.logger.warn({ msg: `checkout/cafe: ${reason}` })

  return Response.json({ message, ok: false }, { headers: noStore, status })
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

const relationId = (value: unknown): string =>
  value && typeof value === 'object' ? String((value as { id: unknown }).id) : String(value ?? '')

/**
 * Resolve one buyer-supplied coupon code against this site's own coupon book.
 *
 * The code is the only thing the body contributes; the amount, window, usage
 * ceiling and product restriction all come from the row — the same rule as
 * the product's price. A refund restores usage in `settleStock`, and a
 * coupon is only *spent* when its order crosses into paid, so an abandoned
 * checkout cannot burn a limited code.
 */
const resolveCheckoutCoupon = async ({
  code,
  productId,
  quantity,
  req,
  siteId,
  subtotal,
}: {
  code: string
  productId: string
  quantity: number
  req: PayloadRequest
  siteId: string
  subtotal: number
}): Promise<null | { coupon: Coupon; discount: number }> => {
  const { docs } = await req.payload.find({
    collection: 'coupons',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ site: { equals: siteId } }, { code: { equals: code.trim().toUpperCase() } }],
    },
  })
  const coupon = docs[0] as Coupon | undefined

  if (!coupon || coupon.active === false) return null

  const now = Date.now()
  const starts = coupon.startsAt ? Date.parse(coupon.startsAt) : Number.NaN
  const expires = coupon.expiresAt ? Date.parse(coupon.expiresAt) : Number.NaN
  if (Number.isFinite(starts) && now < starts) return null
  if (Number.isFinite(expires) && now > expires) return null

  const usageLimit = Number(coupon.usageLimit ?? 0)
  if (usageLimit > 0 && Number(coupon.usageCount ?? 0) >= usageLimit) return null

  const minimum = Number(coupon.minimumAmount ?? 0)
  const maximum = Number(coupon.maximumAmount ?? 0)
  if (minimum > 0 && subtotal < minimum) return null
  if (maximum > 0 && subtotal > maximum) return null

  const included = (coupon.products ?? []).map(relationId)
  const excluded = (coupon.excludedProducts ?? []).map(relationId)
  if (included.length > 0 && !included.includes(productId)) return null
  if (excluded.includes(productId)) return null

  const amount = Number(coupon.amount ?? 0)
  const discount =
    coupon.discountType === 'percent'
      ? Math.floor((subtotal * amount) / 100)
      : coupon.discountType === 'fixed-product'
        ? Math.min(subtotal, Math.trunc(amount) * quantity)
        : Math.min(subtotal, Math.trunc(amount))

  return discount > 0 ? { coupon, discount } : null
}

/**
 * The order already created for this (site, request id), or null.
 *
 * `depth: 0` and one row: this runs on the retry path, where the answer is usually
 * "yes" and the only thing wanted back is the document the buyer has already been shown.
 */
const findIdempotentOrder = async ({
  requestId,
  req,
  siteId,
}: {
  requestId: string
  req: PayloadRequest
  siteId: string
}): Promise<Order | null> => {
  const { docs } = await req.payload.find({
    collection: 'orders',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: {
      and: [{ site: { equals: siteId } }, { 'cafe.checkoutRequestId': { equals: requestId } }],
    },
  })

  return (docs[0] as Order | undefined) ?? null
}

/**
 * Public storefront: the guest's cart, for a *retry*.
 *
 * Deliberately the same document the first response produced — same order id, same
 * receipt URL — because the point of idempotency is that the browser cannot tell a
 * lost response from a first one. Nothing here re-initiates a payment: a retry that
 * returned a *new* PSP attempt for the same order would give the guest two live
 * transaction windows and the shop one order to reconcile.
 */
const retryResponse = ({
  locale,
  order,
  site,
  siteId,
}: {
  locale: string
  order: Order
  site: Site
  siteId: string
}) =>
  Response.json(
    {
      confirmationUrl: confirmationUrl({ locale, orderId: String(order.id), site, siteId }),
      ok: true,
      orderId: String(order.id),
      reference: order.reference ?? null,
      // A retry never redirects: the first attempt already answered with the gateway's
      // URL, or with none (counter). Sending the browser somewhere new is how a retried
      // click becomes a second charge attempt.
      redirectUrl: null,
      retry: true,
    },
    { headers: noStore },
  )

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

  /* ------------------------------------------------------------------ café mode */

  const cafe = isCafeCheckout(data)
  const paymentChoiceRaw = data.paymentChoice
  const paymentChoice: null | PaymentChoice = isPaymentChoice(paymentChoiceRaw)
    ? paymentChoiceRaw
    : null
  const serviceMode: null | ServiceMode =
    data.serviceMode === 'dine_in' || data.serviceMode === 'takeaway'
      ? (data.serviceMode as ServiceMode)
      : null
  const tableToken =
    typeof data.tableToken === 'string' && data.tableToken.trim() ? data.tableToken.trim() : null
  const checkoutRequestId = isCheckoutRequestId(data.checkoutRequestId)
    ? data.checkoutRequestId
    : null

  if (cafe && data.paymentChoice !== undefined && paymentChoice === null) {
    return refusedCafe(req, 'unknown payment choice', 'این روش پرداخت در دسترس نیست.', 400)
  }

  if (cafe) {
    // A service mode that was *supplied* but is not one of the two is refused, never
    // coerced: "delivery" quietly becoming "takeaway" is an order the kitchen cannot
    // deliver and a guest who cannot be found.
    if (data.serviceMode !== undefined && serviceMode === null) {
      return refusedCafe(
        req,
        `unsupported service mode ${String(data.serviceMode)}`,
        'این نوع سرویس در دسترس نیست؛ فقط سفارش حضوری یا بیرون‌بر ممکن است.',
        400,
      )
    }

    const serviceRefusal = refuseServiceMode({ serviceMode, tableToken })
    if (serviceRefusal) {
      const message =
        serviceRefusal === 'dine_in_requires_table_token' || serviceRefusal === 'table_token_invalid'
          ? 'نشان میز معتبر نیست. لطفاً QR روی میز را دوباره اسکن کنید یا سفارش بیرون‌بر ثبت کنید.'
          : serviceRefusal === 'takeaway_forbids_table_token'
            ? 'برای سفارش بیرون‌بر نمی‌توان میز انتخاب کرد. صفحه را دوباره باز کنید.'
            : 'این سفارش پذیرفته نشد؛ صفحه را دوباره باز کنید.'

      return refusedCafe(req, serviceRefusal, message, 400)
    }

    if (data.checkoutRequestId !== undefined && !checkoutRequestId) {
      return refusedCafe(req, 'malformed checkout request id', 'این سفارش پذیرفته نشد؛ صفحه را دوباره باز کنید.', 400)
    }

    /**
     * A café order must carry the key, and this is the one place that is *strict*.
     *
     * Everything else about the café path can be made safe without the client: prices
     * are recomputed, the table token is only ever passed through, and the payment
     * provider is chosen server-side. Retry safety cannot. Without a request id the
     * endpoint has no fact that distinguishes "the response was lost, send it again"
     * from "two more coffees", so the two possible behaviours are both wrong: accept and
     * risk a duplicate ticket in the kitchen, or refuse and break a legitimate second
     * order from the same table.
     *
     * The storefront client always generates one (see `CafeMenuClient`), so this only
     * ever fires for a headless caller — which is exactly the caller that must be told
     * the rule rather than have its retries guessed at.
     */
    if (!checkoutRequestId) {
      return refusedCafe(
        req,
        'cafe checkout without checkout request id',
        'این سفارش پذیرفته نشد؛ صفحه را دوباره باز کنید و سفارش تازه‌ای ثبت کنید.',
        400,
      )
    }
  }

  // The legacy product/quantity request remains unchanged. A cart is an
  // explicit items[] request, bounded before any reads; client prices are ignored.
  const isCart = data.items !== undefined
  if (isCart && (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 50)) {
    return badRequest('items out of range')
  }
  const submitted = isCart
    ? data.items as unknown[]
    : [{ product: data.product, quantity: data.quantity, variation: data.variation, modifiers: data.modifiers }]
  const requestedLines: { productId: string; quantity: number; variation: string; modifiers: unknown }[] = []
  for (const value of submitted) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return badRequest('invalid item')
    const line = value as Record<string, unknown>
    if (!isUuid(line.product)) return badRequest('product id missing or malformed')
    const quantity = Number(line.quantity ?? 1)
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) return badRequest('quantity out of range')
    if (line.variation !== undefined && typeof line.variation !== 'string') return badRequest('invalid variation')
    if (line.modifiers !== undefined && !Array.isArray(line.modifiers)) return badRequest('invalid modifiers')
    requestedLines.push({ productId: line.product, quantity, variation: typeof line.variation === 'string' ? line.variation.trim() : '', modifiers: line.modifiers })
  }
  // A café order is a café order: several lines, a table or a bag, no shipping. A
  // request that names no table and no bag but sends a café field is a client that half
  // updated — it gets a refusal rather than a silent assignment of "takeaway", because
  // guessing would hand the kitchen a mode the guest never chose.
  if (cafe && serviceMode === null) {
    return refusedCafe(req, 'cafe checkout without service mode', 'نوع سرویس سفارش مشخص نیست؛ صفحه را دوباره باز کنید.', 400)
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

  // Prices, options and availability always come from current published rows,
  // scoped to the Host-derived site. Reusing a row within this request avoids
  // repeated reads for the same product with different modifier configurations.
  const requestedLocale = typeof data.locale === 'string' && isLocale(data.locale) &&
    (site.availableLocales as readonly string[] ?? []).includes(data.locale) ? data.locale as 'fa' | 'en' : site.defaultLocale ?? 'fa'
  const productCache = new Map<string, Product>()
  const stockPools = new Map<string, { available: number; quantity: number }>()
  const resolvedLines: NonNullable<Order['items']> = []

  for (const requested of requestedLines) {
    let product = productCache.get(requested.productId)
    if (!product) {
      const { docs } = await findForSite('products', String(site.id), {
        depth: 0, limit: 1, locale: requestedLocale, pagination: false,
        where: { id: { equals: requested.productId } },
      })
      product = docs[0] as Product | undefined
      if (!product) return refused(req, `product ${requested.productId} not purchasable on ${site.domain}`)
      productCache.set(requested.productId, product)
    }
    if (product.menuAvailability && product.menuAvailability !== 'available') {
      return refused(req, `product ${requested.productId} is not available`)
    }

    const productType = product.productType ?? 'simple'
    if (productType === 'grouped' || productType === 'external') {
      return refused(req, `product ${requested.productId} is ${productType} and not directly purchasable`)
    }
    const variation = productType === 'variable'
      ? (product.variations ?? []).find((candidate) => candidate.key === requested.variation && candidate.active !== false)
      : undefined
    if (productType === 'variable' && !variation) return badRequest('a purchasable variation key is required')
    if (productType !== 'variable' && requested.variation) return badRequest('variation supplied for a non-variable product')

    const stockRow = variation?.trackInventory ? variation : product
    if (stockRow.trackInventory) {
      if (!Number.isSafeInteger(stockRow.inventory) || Number(stockRow.inventory) < 0) {
        return refused(req, `tracked stock for product ${requested.productId} is unknown`)
      }
      const key = `${requested.productId}:${variation?.trackInventory ? variation.key : ''}`
      const pool = stockPools.get(key) ?? { available: Number(stockRow.inventory), quantity: 0 }
      pool.quantity += requested.quantity
      stockPools.set(key, pool)
    }

    const selection = resolveModifiers(product.modifierGroups, requested.modifiers)
    if (!selection.ok) return badRequest('invalid modifier selection')
    const basePrice = Number(variation?.price ?? product.price ?? 0)
    const unitPrice = basePrice + selection.priceDelta
    const lineSubtotal = unitPrice * requested.quantity
    if (!Number.isSafeInteger(basePrice) || basePrice < 0 || !Number.isSafeInteger(unitPrice) || unitPrice < 1 || !Number.isSafeInteger(lineSubtotal)) {
      return refused(req, `product ${requested.productId} has no usable price`)
    }
    resolvedLines.push({
      product: product.id,
      productTitle: product.title,
      quantity: requested.quantity,
      ...(variation?.sku ? { sku: variation.sku } : product.sku ? { sku: product.sku } : {}),
      ...(product.externalInventory || product.menuSourceSystem === 'biza_miz' ? { externalInventory: true } : {}),
      ...(selection.snapshots.length ? { modifiers: selection.snapshots } : {}),
      subtotal: lineSubtotal,
      taxTotal: 0,
      total: lineSubtotal,
      unitPrice,
      ...(variation?.key ? { variationKey: variation.key } : {}),
      ...(variation?.label ? { variationLabel: variation.label } : {}),
    })
  }

  for (const { available, quantity } of stockPools.values()) {
    if (available < quantity) {
      return Response.json(
        { available, message: available === 0 ? 'این محصول تمام شده است.' : `تنها ${available} عدد از این محصول موجود است.`, ok: false },
        { headers: noStore, status: 409 },
      )
    }
  }
  const first = resolvedLines[0]!
  const product = productCache.get(String(first.product))!
  const quantity = first.quantity
  const unitPrice = first.unitPrice

  /**
   * Idempotency, for a café cart.
   *
   * The client's request id is chosen once per cart composition. Two requests with the
   * same id and the same basket are one order — the second one gets the first one's
   * receipt URL and creates nothing. Two requests with the same id and a *different*
   * basket are a client reusing a key, which is refused: returning the old order would
   * hand over food the guest already edited, and creating a new one would break the
   * promise the key makes.
   *
   * Looked up *before* the duplicate guard and *before* order creation, because the whole
   * point is that a retry costs one indexed read and no writes at all. The unique index
   * on `(site, checkoutRequestId)` closes the race two simultaneous retries would
   * otherwise win twice; the create below catches that conflict and re-reads.
   */
  const fingerprint = cartFingerprint(resolvedLines.map((line) => ({
    modifiers: (line.modifiers ?? []).map((modifier) => ({ groupId: modifier.groupSourceId, optionIds: [modifier.optionSourceId] })),
    productId: String(line.product),
    quantity: line.quantity,
    variation: line.variationKey ?? '',
  })))

  const replay = async (): Promise<null | Response> => {
    if (!checkoutRequestId) return null

    const existing = await findIdempotentOrder({ requestId: checkoutRequestId, req, siteId: String(site.id) })
    if (!existing) return null

    if (existing.cafe?.cartFingerprint && existing.cafe.cartFingerprint !== fingerprint) {
      return refusedCafe(
        req,
        `checkout request ${checkoutRequestId} replayed with a different cart`,
        'سبد سفارش شما تغییر کرده است. صفحه را دوباره باز کنید و سفارش تازه‌ای ثبت کنید.',
        409,
      )
    }

    req.payload.logger.info({ msg: `checkout: replay of order ${existing.id} for request ${checkoutRequestId}` })

    return retryResponse({ locale: requestedLocale, order: existing, site, siteId: String(site.id) })
  }

  const replayed = await replay()
  if (replayed) return replayed

  /**
   * The duplicate guard — **storefront only**.
   *
   * It exists because a script that rotates IPs is still one phone number, and a table
   * full of `pending` rows is the thing it produces. It is the wrong rule for a café: a
   * table of four ordering separately, or one guest sending a coffee and then a cake, are
   * legitimate distinct orders with one phone between them, and refusing the second is a
   * customer standing at the counter asking why. A café order is instead deduplicated by
   * its request id above, which is the only key that can tell "the same basket twice"
   * from "two baskets".
   */
  const duplicateWindow = duplicateWindowMs()

  if (!isCart && !cafe && duplicateWindow > 0) {
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

  const subtotal = resolvedLines.reduce((sum, line) => sum + line.subtotal, 0)
  if (!Number.isSafeInteger(subtotal)) return badRequest('order total out of range')
  const couponCode = typeof data.couponCode === 'string' ? data.couponCode.trim() : ''
  if (isCart && couponCode) return badRequest('coupons are not supported for cart checkout')
  const appliedCoupon = couponCode
    ? await resolveCheckoutCoupon({
        code: couponCode,
        productId: String(product.id),
        quantity,
        req,
        siteId: String(site.id),
        subtotal,
      })
    : null

  if (couponCode && !appliedCoupon) {
    return Response.json(
      { message: 'کد تخفیف معتبر نیست یا برای این خرید قابل استفاده نمی‌باشد.', ok: false },
      { headers: noStore, status: 400 },
    )
  }

  const discountTotal = appliedCoupon?.discount ?? 0
  const total = subtotal - discountTotal
  const locale = requestedLocale

  /**
   * Which gateway takes this order — the buyer's choice, or the site's.
   *
   * Resolved *before* the order is created, so a stale picker cannot leave a `pending`
   * row behind that the duplicate guard will then hold against the buyer for fifteen
   * minutes. `listEnabledGateways` answers it without decrypting anything: a gateway the
   * site has not switched on, has not configured, or whose amount window excludes this
   * basket is simply not in the list.
   *
   * ## Pay at the counter (ESH-150)
   *
   * `paymentChoice: 'counter'` short-circuits the whole selection: the order is created
   * unpaid with `payment.provider: 'counter'`, no gateway list is read and no PSP is
   * called. A `gateway` sent alongside it is ignored rather than refused — a storefront
   * that keeps its gateway picker rendered while the guest switches to «پرداخت در صندوق»
   * is behaving correctly, and the choice is the buyer's, not the picker's.
   */
  const payAtCounter = cafe && paymentChoice === 'counter'
  const requestedGateway = payAtCounter
    ? null
    : typeof data.gateway === 'string' && data.gateway.trim() ? data.gateway.trim() : null

  if (requestedGateway !== null && !isGatewayId(requestedGateway)) return badRequest('unknown gateway')

  let provider: PaymentProvider

  if (payAtCounter) {
    provider = resolvePaymentProvider(COUNTER_PROVIDER)
  } else {
    const methods = await listEnabledGateways({
      amount: total,
      currency,
      req,
      siteId: String(site.id),
    })

    if (requestedGateway) {
      const method = methods.find(({ id }) => id === requestedGateway)

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
  }

  const orderData = {
    buyer,
    currency,
    // The multi-line shape, with the legacy single-product fields kept as
    // the mirror older receipts/integrations read.
    items: resolvedLines,
    discountTotal,
    ...(appliedCoupon
      ? {
          coupons: [
            {
              code: appliedCoupon.coupon.code,
              coupon: appliedCoupon.coupon.id,
              discount: discountTotal,
            },
          ],
        }
      : {}),
    // The café facts, only when this is a café order: an ordinary store order must not
    // grow an `awaiting_approval` it will never leave.
    ...(cafe
      ? {
          cafe: {
            ...(checkoutRequestId ? { cartFingerprint: fingerprint, checkoutRequestId } : {}),
            fulfillment: 'awaiting_approval' as const,
            ...(paymentChoice ? { paymentChoice } : {}),
            serviceMode: serviceMode as ServiceMode,
            ...(tableToken ? { tableToken } : {}),
          },
        }
      : {}),
    payment: { provider: provider.name },
    reference: newOrderReference(),
    product: product.id,
    productTitle: first.productTitle || product.title,
    quantity,
    shippingTotal: 0,
    // The tenant, from the Host — see the header comment.
    site: site.id,
    status: 'pending' as const,
    subtotal,
    taxTotal: 0,
    total,
    unitPrice,
  }

  let order: Order

  try {
    order = await withDerivedSiteWrite(req, () => req.payload.create({
      collection: 'orders',
      data: orderData,
      depth: 0,
      // The collection's own `create` is staff-only on purpose, so that anonymous REST
      // writes to an orders table are impossible. This is the one sanctioned door: the
      // tenant is resolved, the price is computed, and the buyer's details are validated.
      overrideAccess: true,
      req,
    })) as Order
  } catch (error) {
    /**
     * The unique index on `(site, checkoutRequestId)` fired: two requests with the same
     * key raced, and this one lost. That is the *success* case for idempotency — the
     * winner's order exists, so answer with it exactly as a later retry would.
     *
     * A unique-name lookup rather than a message match, because Payload wraps the
     * driver's `23505` in a `ValidationError` whose field path names the columns.
     */
    const conflict = error instanceof ValidationError &&
      (error.data?.errors ?? []).some((entry) => String(entry.path ?? '').includes('checkout_request_id'))

    if (conflict && checkoutRequestId) {
      const existing = await findIdempotentOrder({ requestId: checkoutRequestId, req, siteId: String(site.id) })

      if (existing) return retryResponse({ locale, order: existing, site, siteId: String(site.id) })
    }

    throw error
  }

  const checkoutOrder = toCheckoutOrder({ locale, order, site })

  /**
   * Pay at the counter ends here, deliberately.
   *
   * No `provider.initiate`, because there is nothing to initiate: `counterProvider`
   * returns no redirect and the money moves in the POS's till. The order stands as an
   * ordinary `pending` CMS order — the same state a card-to-card transfer waits in —
   * and the buyer gets the signed receipt URL to show at the counter.
   */
  if (payAtCounter) {
    return Response.json(
      {
        confirmationUrl: confirmationUrl({ locale, orderId: String(order.id), site, siteId: String(site.id) }),
        message: 'سفارش شما ثبت شد؛ پرداخت را در صندوق انجام دهید.',
        ok: true,
        orderId: String(order.id),
        reference: order.reference ?? null,
        // Says which of the two outcomes this is, so a client never has to infer it from
        // a missing redirect.
        paymentChoice: 'counter',
        redirectUrl: null,
      },
      { headers: noStore },
    )
  }

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
      orderId: String(order.id),
      ...(cafe ? { paymentChoice: paymentChoice ?? 'online' } : {}),
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
    /**
     * Card to card and pay-at-counter have nothing to ask: no provider recorded the
     * money, so there is no server-side fact to verify and the order waits for a human.
     *
     * For a counter order this branch is also the *only* path a callback can take — a
     * URL naming a counter order reaches here and stops, which is what makes "no query
     * string, flag or callback body can make an order paid" true for the method with no
     * adapter behind it.
     */
    const message =
      order.payment?.provider === COUNTER_PROVIDER
        ? 'سفارش شما ثبت شد؛ پرداخت را در صندوق انجام دهید.'
        : 'سفارش شما ثبت شد؛ پس از واریز، فروشگاه آن را تأیید می‌کند.'

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
