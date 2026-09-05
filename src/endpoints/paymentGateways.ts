import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { toCheckoutOrder } from '@/lib/checkout'
import { isUuid } from '@/lib/ids'
import { readOrderDocs } from '@/lib/order-receipt'
import { siteFromRequest } from '@/lib/site-query'
import { storeSettingsForSite } from '@/lib/store'
import {
  buildContext,
  gatewayAdapters,
  isGatewayId,
  listEnabledGateways,
  paymentsModuleState,
  probeContextFor,
  resolveGateway,
} from '@/payments/gateways'

/**
 * Three doors onto the payment-gateway module, none of which is the admin UI's.
 *
 * `/api/payments/methods` is the public one and the reason the module is "reachable
 * securely from the API": a headless renderer needs to draw the buyer's gateway picker,
 * and it must be able to do that without a session, without credentials, and without ever
 * seeing a merchant's `client_secret`. What it gets is `EnabledGateway` — labels, blurbs,
 * the amount window, whether a mobile number is mandatory — which is the same information
 * a shopper standing at a physical till can read off the sticker on the card reader.
 *
 * The other two are staff doors and are authorised differently, because they do different
 * things:
 *
 * - `POST /api/payments/self-test` makes *this server* call a live merchant account. Only
 *   a platform admin may cause that: the credentials are theirs, and a tenant-triggered
 *   probe is a way to make the platform's IP do things against a PSP on somebody's behalf.
 * - `POST /api/payments/cancel` reverses a payment. Anybody the `payment-gateways`
 *   collection lets read the row may ask — which is that site's staff and that site's own
 *   API key, and nobody else. Enforced by asking Payload rather than by hand-rolling a
 *   role check: `findByID` *without* `overrideAccess` runs the collection's `read` access
 *   and the multi-tenant plugin's narrowing together, so the rule stays in one file.
 *
 * All three resolve the tenant from the `Host` header, per `CLAUDE.md`. None of them takes
 * a site id, and `/api/payments/methods` is one of the Caddy carve-outs so a buyer's
 * browser can reach it on its own domain.
 */

const noStore = { 'cache-control': 'no-store' }

const body = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  await addDataAndFileToRequest(req)

  return (req.data ?? {}) as Record<string, unknown>
}

const json = (payload: Record<string, unknown>, status = 200): Response =>
  Response.json(payload, { headers: noStore, status })

/**
 * `GET /api/payments/methods?amount=<minor units>`
 *
 * Which gateways this site will take right now, in the order the buyer should see them.
 *
 * `amount` is optional and in the site's own minor units (`src/lib/money.ts`), because a
 * gateway's window is quoted in those units too: Snapp!Pay's provider minimum is a Rial
 * figure converted once, in `amountWindow`, and re-converting it here would be the second
 * place a Toman/Rial mix-up could hide. Without `amount` every enabled gateway is returned
 * — that is what a product card shows before the buyer has chosen a quantity — and the
 * checkout endpoint re-checks the window when they commit.
 *
 * Public, and safe to be: `listEnabledGateways` reads the rows under `overrideAccess` with
 * an explicit `site` predicate (a buyer has no session to authorise against, and a row's
 * existence is not public even though its label is) and returns `EnabledGateway`, a
 * projection with no credential field in it at all. There is no `select` or serializer
 * between that type and this response that could widen it.
 */
export const paymentMethods: Endpoint['handler'] = async (req) => {
  const site = await siteFromRequest(req)

  if (!site) return json({ message: 'unknown host', methods: [] }, 400)

  const locale = site.defaultLocale ?? 'fa'
  const { currency, paymentProvider } = await storeSettingsForSite(String(site.id), { locale })

  const raw = new URL(req.url ?? '', 'http://localhost').searchParams.get('amount')

  let amount: null | number = null

  if (raw !== null) {
    const parsed = Number(raw)

    if (!Number.isInteger(parsed) || parsed < 0) {
      return json({ message: 'amount must be a non-negative integer', methods: [] }, 400)
    }

    amount = parsed
  }

  const methods = await listEnabledGateways({
    amount,
    currency,
    locale,
    req,
    siteId: String(site.id),
  })

  return json({
    currency,
    /**
     * The site's configured *method*, so a renderer that has not been taught about gateways
     * still knows what the fallback is. `bank` means card-to-card: the buyer pays and the
     * shop confirms by hand.
     */
    defaultProvider: isGatewayId(paymentProvider ?? undefined) ? null : paymentProvider,
    methods,
  })
}

/**
 * `POST /api/payments/self-test` — platform admin only.
 *
 * Runs the adapter's `healthCheck`: ZarinPal asks for its unverified transactions, Digipay
 * and Snapp!Pay take an OAuth token, Torob Pay gets a reachability probe (it has no
 * read-only endpoint, and its adapter says so rather than pretending a 200 proved
 * anything). None of them creates a transaction, which is the rule `GatewayAdapter` sets —
 * this runs against a live merchant account.
 *
 * The result is written back onto the row so the next person to look at it can see whether
 * the credentials were ever known to work, which is the only way to tell "the merchant id
 * was mistyped" from "the PSP is down".
 */
export const paymentSelfTest: Endpoint['handler'] = async (req) => {
  const data = await body(req)
  const { user } = await req.payload.auth({ headers: req.headers, req })

  if (!isPlatformAdmin(user)) {
    return json({ message: 'فقط کارکنان سکو می‌توانند خودآزمایی اجرا کنند.', ok: false }, 403)
  }

  const id = typeof data.id === 'string' ? data.id : null

  if (!isUuid(id)) return json({ message: 'شناسهٔ ردیف نامعتبر است.', ok: false }, 400)

  const rowId = id

  let context

  try {
    context = await probeContextFor({ req, rowId })
  } catch (error) {
    return json({ message: (error as Error).message, ok: false }, 404)
  }

  const adapter = gatewayAdapters[context.descriptor.id]

  if (!adapter.healthCheck) {
    return json({
      detail: 'این درگاه هیچ بررسیِ بدونِ تراکنشی ندارد.',
      message: 'خودآزمایی برای این درگاه پشتیبانی نمی‌شود.',
      ok: false,
    }, 501)
  }

  const startedAt = Date.now()
  const result = await adapter.healthCheck(context)

  const detail = `${result.detail ?? ''} (${Date.now() - startedAt}ms)`.trim()

  // `overrideAccess`, because the self-test columns deny writes to every caller — they are
  // this endpoint's and nothing else's to fill.
  await req.payload.update({
    id: rowId,
    collection: 'payment-gateways',
    data: { selfTestAt: new Date().toISOString(), selfTestDetail: detail, selfTestOk: result.ok },
    depth: 0,
    overrideAccess: true,
    req,
  })

  return json({ detail, gateway: context.descriptor.id, mode: context.mode, ok: result.ok }, result.ok ? 200 : 502)
}

/**
 * `POST /api/payments/cancel` — reverse a payment on a `paid` order.
 *
 * Takes an **order**, not a gateway row: what a shop owner is doing is undoing a specific
 * customer's payment, and the gateway to ask is the one recorded on that order. Deriving
 * it from the row instead would let a caller reverse a transaction against whichever
 * credentials they named.
 *
 * Staff-only, and the check is Payload's own: reading the row without `overrideAccess` runs
 * `payment-gateways`' `read` access plus the multi-tenant narrowing, so a site's staff and
 * a site's own API key get through and every other caller gets a 404 for a row that exists.
 *
 * Not offered to buyers, not idempotent-by-accident: Digipay's `reverse` and Snapp!Pay's
 * `revert` move money back, so this endpoint deliberately does not fall back to anything
 * when the provider has no cancel — ZarinPal does not, and an adapter that invented one
 * would be worse than one that says it cannot.
 */
export const paymentCancel: Endpoint['handler'] = async (req) => {
  const data = await body(req)

  const site = await siteFromRequest(req)

  if (!site) return json({ message: 'unknown host', ok: false }, 400)

  const orderId = typeof data.order === 'string' ? data.order : null

  if (!isUuid(orderId)) return json({ message: 'شناسهٔ سفارش نامعتبر است.', ok: false }, 400)

  const found = await readOrderDocs(req.payload, orderId, String(site.id))

  if (!found) return json({ message: 'سفارش یافت نشد.', ok: false }, 404)

  const { order } = found
  const gateway = order.payment?.provider

  if (!isGatewayId(gateway)) {
    return json({
      message: 'این سفارش با درگاه آنلاین پرداخت نشده است؛ بازگشت وجه دستی انجام می‌شود.',
      ok: false,
    }, 409)
  }

  // Payload's own access control, by asking for the row the ordinary way.
  try {
    await req.payload.find({
      collection: 'payment-gateways',
      depth: 0,
      limit: 1,
      pagination: false,
      req,
      where: { and: [{ gateway: { equals: gateway } }, { site: { equals: site.id } }] },
    })
  } catch {
    return json({ message: 'شما به پیکربندی این درگاه دسترسی ندارید.', ok: false }, 403)
  }

  const resolution = await resolveGateway({
    currency: order.currency,
    gateway,
    locale: site.defaultLocale ?? 'fa',
    req,
    siteId: String(site.id),
  })

  if (!resolution.ok) return json({ message: resolution.reason, ok: false }, 409)

  const adapter = gatewayAdapters[gateway]

  if (!adapter.cancel) {
    return json({
      message: `${resolution.gateway.descriptor.label} بازگشت وجه از راه API ندارد؛ از پنل پذیرنده اقدام کنید.`,
      ok: false,
    }, 501)
  }

  const result = await adapter.cancel(
    buildContext({
      // No `locale` on an order: what the PSP is told about a product is the site's own
      // default-locale title, which is the same choice `startCheckout` makes.
      order: toCheckoutOrder({ locale: site.defaultLocale ?? 'fa', order, site }),
      paymentReference: order.payment?.reference ?? undefined,
      req,
      resolution,
    }),
  )

  if (!result.ok) {
    req.payload.logger.warn({
      gateway,
      msg: `payments cancel refused for order ${order.id}`,
      reason: result.reason,
    })

    return json({ message: result.reason ?? 'بازگشت وجه انجام نشد.', ok: false }, 409)
  }

  /**
   * The reversal is recorded, the status is not touched.
   *
   * Moving a `paid` order to `refunded` is the shop's decision — it changes what the owner
   * sees in their own list, triggers stock handling, and may be wrong (a partial refund, a
   * reversal the PSP later fails to settle). This endpoint's job is to move the money back
   * and leave a durable record that it did; the status follows in the admin, by a person.
   */
  await req.payload.update({
    id: order.id,
    collection: 'orders',
    data: {
      payment: {
        gatewayData: {
          ...((order.payment?.gatewayData as Record<string, unknown> | undefined) ?? {}),
          cancelledAt: new Date().toISOString(),
          ...(result.data ?? {}),
        },
        provider: gateway,
        reference: order.payment?.reference ?? undefined,
      },
    },
    depth: 0,
    overrideAccess: true,
    req,
  })

  return json({
    gateway,
    message: 'بازگشت وجه انجام شد. وضعیت سفارش را خودتان تغییر دهید.',
    ok: true,
    ...(result.data ? { data: result.data } : {}),
  })
}

/**
 * `GET /api/payments/status` — platform admin only.
 *
 * Which gateways the platform has allowlisted, whether the module is on, and how many sites
 * have each one switched on. Not a metrics dashboard: it is the answer to "a customer says
 * their Digipay stopped working — is that us or them?", which otherwise means reading the
 * `payments` global and then counting rows by hand.
 */
export const paymentStatus: Endpoint['handler'] = async (req) => {
  const { user } = await req.payload.auth({ headers: req.headers, req })

  if (!isPlatformAdmin(user)) return json({ message: 'forbidden', ok: false }, 403)

  const state = await paymentsModuleState(req)
  const counts = await Promise.all(
    state.allowed.map(async (gateway) => ({
      enabled: (
        await req.payload.count({
          collection: 'payment-gateways',
          overrideAccess: true,
          req,
          where: { and: [{ enabled: { equals: true } }, { gateway: { equals: gateway } }] },
        })
      ).totalDocs,
      gateway,
      rows: (
        await req.payload.count({
          collection: 'payment-gateways',
          overrideAccess: true,
          req,
          where: { gateway: { equals: gateway } },
        })
      ).totalDocs,
    })),
  )

  return json({ allowed: state.allowed, counts, moduleEnabled: state.enabled, ok: true })
}

export const paymentGatewayEndpoints: Endpoint[] = [
  { handler: paymentMethods, method: 'get', path: '/payments/methods' },
  { handler: paymentStatus, method: 'get', path: '/payments/status' },
  { handler: paymentSelfTest, method: 'post', path: '/payments/self-test' },
  { handler: paymentCancel, method: 'post', path: '/payments/cancel' },
]
