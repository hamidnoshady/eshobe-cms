import type { GatewayAdapter, GatewayProbeContext, GatewayResultData } from '../types'

import { amountIn, amountMatches, currencySetting } from '../amount'
import { gatewayFetch, joinUrl, pick, pickUrl } from '../net'

/**
 * Torob Pay (ترب‌پی) — Torob's instalment gateway.
 *
 * **Torob publishes no API documentation.** Approved merchants receive a gateway address
 * and credentials from Torob support after their panel request is approved; the
 * WooCommerce/Payzito integrations that exist in the wild all configure exactly three
 * things — a username, a password/token, and a gateway URL — and none of them publishes
 * the request shape either. Pretending otherwise would mean inventing field names and
 * calling it an integration.
 *
 * So this adapter does the honest thing: it implements the flow every Iranian gateway has
 * — *create → redirect the buyer → verify server to server → optionally cancel* — against
 * **per-row configurable endpoints**, and it reads the response tolerantly across the field
 * names the documented providers in this directory actually use. When Torob's technical
 * document arrives, three things happen and none of them is a rewrite:
 *
 * 1. its paths go into the row's `createPath` / `verifyPath` / `cancelPath`;
 * 2. its field names replace the candidate lists in `REFERENCE_KEYS` and `REDIRECT_KEYS`;
 * 3. `docs/payment-gateways.md` §"Torob Pay" stops saying "undocumented".
 *
 * ## What is *not* configurable
 *
 * The security properties. Whichever paths and field names a merchant's panel produced:
 *
 * - the buyer's redirect is never believed, and `confirm` always calls the verify endpoint;
 * - the reference sent to verify is the one **we** stored at initiate, never one from the
 *   query string;
 * - the amount the gateway reports is compared against the order before it is accepted;
 * - the base URL is checked against `allowedHosts` and against the private-address floor in
 *   `net.ts`, so a row cannot point this server at its own metadata service.
 *
 * A configurable *contract* that was also a configurable *policy* would be a hole with a
 * form on it.
 */

/** Paths that work against the shape Iranian PSPs converge on. Overridable per row. */
const DEFAULT_PATHS = {
  cancel: '/v1/payments/cancel',
  create: '/v1/payments',
  verify: '/v1/payments/verify',
}

/** Every key a create response is known to carry the transaction reference under. */
const REFERENCE_KEYS = [
  'reference',
  'token',
  'paymentToken',
  'paymentId',
  'transactionId',
  'trackingCode',
  'authority',
  'data.reference',
  'data.token',
  'data.paymentId',
  'data.transactionId',
  'data.trackingCode',
  'data.authority',
  'result.reference',
]

/** Every key a create response is known to carry the buyer's pay-page URL under. */
const REDIRECT_KEYS = [
  'redirectUrl',
  'payUrl',
  'paymentUrl',
  'url',
  'data.redirectUrl',
  'data.payUrl',
  'data.url',
  'result.redirectUrl',
]

const SUCCESS_VALUES = new Set([
  '1',
  '100',
  '101',
  'OK',
  'PAID',
  'SETTLED',
  'SUCCESS',
  'SUCCESSFUL',
  'TRUE',
  'VERIFIED',
])

/**
 * Did the gateway refuse this call? Checked before any success marker, because a response
 * can carry both (`{ status: 'error', data: { code: 100 } }` is not a success).
 */
const refused = (json: null | Record<string, unknown>): boolean => {
  if (json === null) return true
  if (json.ok === false || json.success === false || json.verified === false) return true
  if (String(pick(json, 'status') ?? '').toLowerCase() === 'error') return true

  const errors = json.errors
  if (Array.isArray(errors) && errors.length > 0) return true
  if (errors && typeof errors === 'object') return true

  const code = pick(json, 'data.code', 'result.status', 'code')

  // ZarinPal-shaped: 100/101 are success, any negative code is a refusal. Digipay-shaped:
  // `result.status: 0` is success. A provider that answers neither shape falls through to
  // the explicit success markers below.
  if (typeof code === 'number') return code !== 0 && code !== 100 && code !== 101

  return false
}

/**
 * Did the gateway say the payment happened?
 *
 * Every branch is an *explicit* affirmative. There is no "HTTP 200 therefore paid": a
 * gateway that answers 200 to a verify it did not understand would otherwise mark orders
 * paid, and this adapter is the one whose response shape is least known, so it is the one
 * that has to be strictest about what counts as a yes.
 */
const paid = (json: null | Record<string, unknown>): boolean => {
  if (refused(json)) return false
  if (json === null) return false

  if (json.ok === true || json.success === true || json.verified === true || json.paid === true) {
    return true
  }

  return ['data.code', 'result.status', 'result', 'status', 'state', 'paymentStatus', 'code'].some(
    (path) => {
      const value = pick(json, path)

      return value !== null && SUCCESS_VALUES.has(String(value).toUpperCase())
    },
  )
}

/** `Bearer` when the row has a token, HTTP Basic over the username/password pair otherwise. */
const authHeaders = (context: GatewayProbeContext): Record<string, string> => {
  const { password, token, username } = context.credentials

  if (token?.trim()) return { authorization: `Bearer ${token.trim()}` }

  if (username?.trim() && password) {
    return {
      authorization: `Basic ${Buffer.from(`${username.trim()}:${password}`, 'utf8').toString('base64')}`,
    }
  }

  throw new Error('torobPay: the row has neither a gateway token nor a username/password pair')
}

const path = (context: GatewayProbeContext, key: 'cancel' | 'create' | 'verify'): string => {
  const configured = context.settings[`${key}Path`]?.trim()

  return configured || DEFAULT_PATHS[key]
}

export const torobPayAdapter: GatewayAdapter = {
  id: 'torobPay',

  initiate: async (context) => {
    const { descriptor, order, req } = context

    const base = context.settings.baseUrl?.trim()

    // `baseUrl` is `required: true` on this descriptor and `resolve.ts` refuses a row
    // missing it, so this is the "someone changed the registry" guard rather than a user
    // path — but a Torob call to a *defaulted* URL would be a call to a URL nobody vetted.
    if (!base) throw new Error('torobPay: the row has no gateway base URL')

    const { amount, unit } = amountIn(order, currencySetting(context.settings.amountUnit, order.currency))

    const response = await gatewayFetch(
      joinUrl(base, path(context, 'create')),
      descriptor.allowedHosts,
      {
        body: {
          amount,
          callbackUrl: context.callbackUrl,
          currency: unit,
          description: `سفارش ${order.reference} — ${order.productTitle}`.slice(0, 250),
          ...(order.buyer.email ? { email: order.buyer.email } : {}),
          mobile: order.buyer.phone,
          name: order.buyer.name,
          orderId: String(order.id),
          // Both, because the two names are the ones the documented Iranian gateways use
          // for "your own unique id for this purchase", and this is the value `confirm`
          // cross-checks the callback against.
          providerId: String(order.id),
          reference: order.reference,
        },
        headers: authHeaders(context),
        method: 'POST',
      },
      req,
    )

    if (!response.ok || refused(response.json)) {
      req.payload.logger.error({
        msg: `torobPay: create refused for order ${order.id}`,
        torobPay: { status: response.status },
      })

      throw new Error(`torobPay create refused (${response.status})`)
    }

    const redirectUrl = pickUrl(response.json, ...REDIRECT_KEYS)
    const reference = pick(response.json, ...REFERENCE_KEYS)

    // A create that returned neither a URL nor a reference cannot be reconciled, ever: there
    // is no way to send the buyer anywhere and no key to verify with. `src/payments/http.ts`
    // makes the same call about the same situation.
    if (!redirectUrl && !reference) {
      throw new Error('torobPay create response had neither a redirect URL nor a reference')
    }

    return {
      data: {
        amountSent: amount,
        unit,
        ...(typeof reference === 'string' || typeof reference === 'number'
          ? { reference: String(reference) }
          : {}),
      } satisfies GatewayResultData,
      paymentReference: reference === null ? undefined : String(reference),
      redirectUrl,
    }
  },

  confirm: async (context) => {
    const { callback, descriptor, order, paymentReference, req } = context

    const base = context.settings.baseUrl?.trim()

    if (!base) return { ok: false, reason: 'نشانی درگاه ترب‌پی برای این سایت تنظیم نشده است.' }
    if (!paymentReference) {
      return { ok: false, reason: 'کد پیگیری درگاه در دسترس نیست.' }
    }

    /**
     * What came back, for cross-checking only. The reference sent to verify is the stored
     * one, never a value from the query string — that substitution is the difference between
     * "ask about this order" and "ask about whatever the caller named".
     */
    const source: Record<string, unknown> = { ...(callback?.query ?? {}), ...(callback?.body ?? {}) }

    const echoedReference = pick(source, ...REFERENCE_KEYS, 'reference', 'token', 'authority')

    if (echoedReference && String(echoedReference) !== String(paymentReference)) {
      req.payload.logger.warn({
        msg: `torobPay: callback reference does not match order ${order.id}`,
        torobPay: { got: String(echoedReference), want: String(paymentReference) },
      })

      return { ok: false, reason: 'اطلاعات بازگشتی درگاه با این سفارش مطابقت ندارد.' }
    }

    const echoedProvider = pick(source, 'providerId', 'orderId', 'order_id')

    if (echoedProvider && String(echoedProvider) !== String(order.id)) {
      req.payload.logger.warn({ msg: `torobPay: callback providerId does not match order ${order.id}` })

      return { ok: false, reason: 'اطلاعات بازگشتی درگاه با این سفارش مطابقت ندارد.' }
    }

    let response

    try {
      response = await gatewayFetch(
        joinUrl(base, path(context, 'verify')),
        descriptor.allowedHosts,
        {
          body: {
            amount: amountIn(order, currencySetting(context.settings.amountUnit, order.currency)).amount,
            orderId: String(order.id),
            providerId: String(order.id),
            reference: String(paymentReference),
          },
          headers: authHeaders(context),
          method: 'POST',
        },
        req,
      )
    } catch (error) {
      req.payload.logger.error({
        err: error as Error,
        msg: `torobPay: verify failed for order ${order.id}`,
      })

      return { ok: false, reason: 'ارتباط با درگاه برقرار نشد؛ دوباره تلاش کنید.' }
    }

    if (!paid(response.json)) {
      req.payload.logger.warn({
        msg: `torobPay: verify did not confirm order ${order.id}`,
        torobPay: { status: response.status },
      })

      return {
        data: {
          message: pick(response.json, 'message', 'result.message', 'error') ?? undefined,
          reference: String(paymentReference),
        } satisfies GatewayResultData,
        ok: false,
        reason:
          response.status === 401 || response.status === 403
            ? 'اعتبارنامهٔ درگاه ترب‌پی پذیرفته نشد.'
            : 'پرداخت توسط درگاه تأیید نشد.',
      }
    }

    /**
     * The amount the gateway reports, if it reports one. Compared in the unit the row
     * sends in — a Torob account quoting Toman against an order in Rial is the exact 10×
     * error `amountMatches` exists to catch.
     */
    const reportedAmount = pick(response.json, 'amount', 'data.amount', 'paidAmount', 'value')
    const reportedUnit = (context.settings.amountUnit || 'IRR') as 'IRR' | 'IRT'

    if (reportedAmount !== null && !amountMatches(order, reportedAmount, reportedUnit)) {
      req.payload.logger.error({
        msg: `torobPay: verified amount does not match order ${order.id}`,
        torobPay: { got: String(reportedAmount), unit: reportedUnit },
      })

      return { ok: false, reason: 'مبلغ پرداخت‌شده با مبلغ سفارش مطابقت ندارد.' }
    }

    return {
      data: {
        reference: String(paymentReference),
        rrn: pick(response.json, 'rrn', 'data.rrn') ?? undefined,
        trackingCode: pick(response.json, 'trackingCode', 'data.trackingCode') ?? undefined,
      } satisfies GatewayResultData,
      ok: true,
      paymentReference: String(paymentReference),
    }
  },

  cancel: async (context) => {
    const { descriptor, paymentReference, req } = context

    const base = context.settings.baseUrl?.trim()

    if (!base || !paymentReference) {
      return { ok: false, reason: 'برای لغو، نشانی درگاه و کد پیگیری لازم است.' }
    }

    const response = await gatewayFetch(
      joinUrl(base, path(context, 'cancel')),
      descriptor.allowedHosts,
      {
        body: { orderId: String(context.order.id), reference: String(paymentReference) },
        headers: authHeaders(context),
        method: 'POST',
      },
      req,
    ).catch((error: unknown) => {
      req.payload.logger.error({ err: error as Error, msg: 'torobPay: cancel request failed' })

      return null
    })

    if (!response || refused(response.json)) {
      return { ok: false, reason: 'درگاه ترب‌پی لغو این تراکنش را نپذیرفت.' }
    }

    return { ok: true, paymentReference: String(paymentReference) }
  },

  /**
   * The weakest of the four, and labelled as such in the response.
   *
   * Torob publishes no read-only endpoint, so there is nothing to ask that is both
   * harmless and authenticated. This calls the verify path with a reference that cannot
   * exist and reads only *how* it was refused: a 401/403 means the credentials are wrong,
   * a network or 404 means the address is wrong, and any other answer means the endpoint is
   * there and answering. That is a reachability check, not a credential check, and the
   * `detail` string says so rather than reporting "OK".
   */
  healthCheck: async (context) => {
    const { descriptor, req } = context
    const base = context.settings.baseUrl?.trim()

    if (!base) return { detail: 'نشانی پایهٔ درگاه تنظیم نشده است.', ok: false }

    try {
      const response = await gatewayFetch(
        joinUrl(base, path(context, 'verify')),
        descriptor.allowedHosts,
        {
          body: { orderId: 'health-check', reference: 'health-check' },
          headers: authHeaders(context),
          method: 'POST',
        },
        req,
      )

      if (response.status === 401 || response.status === 403) {
        return { detail: `اعتبارنامه پذیرفته نشد (HTTP ${response.status}).`, ok: false }
      }

      if (response.status === 404) {
        return {
          detail: 'درگاه پاسخ داد اما این مسیر وجود ندارد؛ مسیر تأیید تراکنش را بررسی کنید.',
          ok: false,
        }
      }

      return {
        detail:
          `درگاه در دسترس است (HTTP ${response.status}). ترب مستندات عمومی ندارد، ` +
          'پس این فقط بررسی دسترسی است نه بررسی اعتبارنامه.',
        ok: true,
      }
    } catch (error) {
      return { detail: (error as Error).message, ok: false }
    }
  },
}
