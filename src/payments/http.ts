import type { PaymentConfirmation, PaymentProvider } from './types'

import { siteOrigin } from '@/lib/site-url'

/**
 * A payment gateway over HTTP/JSON — the shape every Iranian PSP integration
 * actually is: *create an invoice → send the buyer to a URL → the buyer comes back →
 * verify server to server*. ZarinPal, IDPay, Saman, Pasargad and friends differ in
 * field names and in whether the verification is a POST or a GET with an OTP; a
 * ~20-line bridge per provider that maps their fields onto this contract is enough,
 * which is why the contract lives here instead of one hardcoded vendor.
 *
 * ## The contract
 *
 * ```
 * POST $PAYMENT_HTTP_CREATE_URL        Authorization: Bearer $PAYMENT_HTTP_TOKEN
 *   { amount, currency, orderId, reference, description, callbackUrl }
 *   → { redirectUrl: string, reference: string }
 *
 * POST $PAYMENT_HTTP_VERIFY_URL        Authorization: Bearer $PAYMENT_HTTP_TOKEN
 *   { orderId, reference, amount }
 *   → { ok: boolean, reference?: string }
 * ```
 *
 * `amount` is in the site's minor unit (whole Toman for an Iranian site). A gateway
 * that wants Rials multiplies by ten — and `tomanToRial()` in `src/lib/money.ts` is
 * the one place allowed to do it, so the factor of ten appears once in the codebase
 * instead of once per adapter.
 *
 * ## Why the redirect is never believed
 *
 * `confirm()` asks the gateway itself, with the shared token, before an order flips
 * to `paid`. The callback's own query parameters are read only for `reference`, to
 * look the attempt up. A browser arriving with `?status=ok` proves nothing about
 * anything.
 */

const REQUEST_TIMEOUT_MS = 8_000

export class PaymentGatewayNotConfigured extends Error {
  constructor() {
    super('درگاه پرداخت پیکربندی نشده است.')
    this.name = 'PaymentGatewayNotConfigured'
  }
}

type GatewayConfig = { createUrl: string; token: string; verifyUrl: string }

/**
 * Read per call, not at module load: the module is imported by the admin bundle and
 * by the payload config, where a missing env var would otherwise take the whole app
 * down at boot for a store that never uses this provider.
 */
const config = (): GatewayConfig => {
  const { PAYMENT_HTTP_CREATE_URL, PAYMENT_HTTP_TOKEN, PAYMENT_HTTP_VERIFY_URL } = process.env

  if (!PAYMENT_HTTP_CREATE_URL || !PAYMENT_HTTP_VERIFY_URL || !PAYMENT_HTTP_TOKEN) {
    throw new PaymentGatewayNotConfigured()
  }

  return {
    createUrl: PAYMENT_HTTP_CREATE_URL,
    token: PAYMENT_HTTP_TOKEN,
    verifyUrl: PAYMENT_HTTP_VERIFY_URL,
  }
}

const post = async (
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    // `no-store` so a dev server with caching enabled never replays a payment.
    cache: 'no-store',
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`gateway responded ${response.status}`)
  }

  const payload: unknown = await response.json().catch(() => null)

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('gateway response was not a JSON object')
  }

  return payload as Record<string, unknown>
}

export const httpProvider: PaymentProvider = {
  confirm: async ({ order, paymentReference, req }): Promise<PaymentConfirmation> => {
    const { token, verifyUrl } = config()

    if (!paymentReference) {
      return { ok: false, reason: 'کد پیگیری درگاه در دسترس نیست.' }
    }

    try {
      const result = await post(verifyUrl, token, {
        amount: order.total,
        orderId: order.id,
        reference: paymentReference,
      })

      if (result.ok === true || result.status === 'ok' || result.status === 'success') {
        return {
          ok: true,
          paymentReference:
            typeof result.reference === 'string' ? result.reference : paymentReference,
        }
      }

      req.payload.logger.warn({ msg: `payment verify refused for order ${order.id}` })

      return { ok: false, reason: 'درگاه، پرداخت را تأیید نکرد.' }
    } catch (error) {
      // Never the token, never the response body: this string is logged.
      req.payload.logger.error({
        err: error as Error,
        msg: `payment verify failed for order ${order.id}`,
      })

      return { ok: false, reason: 'ارتباط با درگاه برقرار نشد؛ دوباره تلاش کنید.' }
    }
  },

  initiate: async ({ order, req }) => {
    const { createUrl, token } = config()

    // Absolute, because the gateway calls it from its own server, and on *the site's*
    // domain — which is how the callback turns the Host back into a tenant.
    // `siteOrigin` is the platform's one answer for "which origin is this site on":
    // dev puts every domain on one port, production on none, and hardcoding either
    // breaks the other.
    const origin = siteOrigin(order.site, req.origin)
    const callbackUrl = `${origin}/api/checkout/callback?order=${encodeURIComponent(order.id)}`

    const result = await post(createUrl, token, {
      amount: order.total,
      callbackUrl,
      currency: order.currency,
      description: `سفارش ${order.reference} — ${order.productTitle}`,
      orderId: order.id,
      reference: order.reference,
    })

    const redirectUrl = typeof result.redirectUrl === 'string' ? result.redirectUrl : null
    const paymentReference = typeof result.reference === 'string' ? result.reference : null

    // A 200 that carries neither is a contract violation, and continuing would
    // create an order with no way to ever reconcile it.
    if (!redirectUrl && !paymentReference) {
      throw new Error('gateway create response had no redirectUrl and no reference')
    }

    return { paymentReference: paymentReference ?? undefined, redirectUrl }
  },

  label: 'درگاه HTTP',
  name: 'http',
}
