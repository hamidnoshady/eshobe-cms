import type { GatewayAdapter, GatewayContext, GatewayResultData } from '../types'

import { amountIn, currencySetting } from '../amount'
import { gatewayFetch, pick, pickUrl } from '../net'

/**
 * ZarinPal — `zarinpal.com/docs/paymentGateway/connectToGateway`, web service v4.
 *
 * ```
 * POST {api}/request.json   { merchant_id, amount, currency, description, callback_url,
 *                             metadata: { mobile, email, order_id }, referrer_id? }
 *   → { data: { code: 100, authority, fee, fee_type, message }, errors: [] }
 * GET  https://www.zarinpal.com/pg/StartPay/{authority}          ← the buyer goes here
 *   → back to callback_url?Status=OK&Authority=…                 (Status=NOK on cancel)
 * POST {api}/verify.json    { merchant_id, amount, authority }
 *   → { data: { code: 100|101, ref_id, card_pan, fee, message }, errors: [] }
 * ```
 *
 * Three properties of this provider drive the code below:
 *
 * - **v4 takes a `currency` field** (`IRR` or `IRT`) instead of assuming Toman the way v3
 *   did, so the site's own unit is sent through unchanged and the factor of ten never
 *   appears here. A merchant whose account was opened in the other unit overrides it with
 *   the `amountUnit` row setting.
 * - **`code: 101` on verify means "already verified"**, which is a success. Treating it as
 *   a failure would double-charge a buyer whose callback fired twice — and ZarinPal
 *   retries.
 * - **There is no callback signature to check.** The only defence is the one this file
 *   implements: `Status` from the query string decides *whether to ask*, and `verify.json`
 *   decides *whether it is paid*. The buyer's browser never does.
 */

const MERCHANT_ID_PATTERN = /^[0-9a-f-]{8,64}$/i

/**
 * v4's error codes, in Persian, for the ones a buyer can act on.
 *
 * Not a complete translation of ZarinPal's table on purpose: an unlisted code falls back
 * to a generic message, and a *specific wrong* message ("the amount does not match") on a
 * code that means something else sends the buyer and the shop chasing different problems.
 */
const ERROR_MESSAGES: Record<string, string> = {
  '-11': 'درخواست یافت نشد.',
  '-21': 'عملیات مالی برای این تراکنش یافت نشد.',
  '-22': 'تراکنش ناموفق بود.',
  '-33': 'مبلغ تراکنش با مبلغ پرداخت‌شده مطابقت ندارد.',
  '-42': 'شناسهٔ پرداخت منقضی شده است. خرید را دوباره آغاز کنید.',
  '-54': 'این درخواست آرشیو شده است.',
}

const FAILED_OR_CANCELLED = 'پرداخت انجام نشد یا توسط شما لغو شد.'

/** `errors` is either `[]` or an object with `code`/`message`/`validations`. */
const errorOf = (json: null | Record<string, unknown>): null | string => {
  const errors = json?.errors

  if (Array.isArray(errors) && errors.length === 0) return null
  if (errors === null || errors === undefined) return null

  const code = pick(errors, 'code')
  const message = pick(errors, 'message')

  return `${code ?? '?'}: ${message ?? 'خطای نامشخص'}`
}

const buildCallbackUrl = (context: GatewayContext): string => context.callbackUrl

export const zarinpalAdapter: GatewayAdapter = {
  /**
   * Not offered. ZarinPal refunds from its own panel, and an API call that claimed to
   * reverse a payment it cannot reverse would be worse than no method at all.
   */
  id: 'zarinpal',

  initiate: async (context) => {
    const { credentials, descriptor, order, req, settings } = context
    const merchantId = (credentials.merchantId ?? '').trim()

    // Checked here rather than only in `resolve.ts`: the merchant id is a uuid-shaped
    // string, and sending a truncated or pasted-with-spaces one produces ZarinPal's `-2`
    // ("the merchant code is wrong") a checkout later, which reads as an outage.
    if (!MERCHANT_ID_PATTERN.test(merchantId)) {
      req.payload.logger.warn({
        msg: `zarinpal: merchant_id on row ${context.rowId} is not a 36-character code`,
      })

      throw new Error('zarinpal merchant_id malformed')
    }

    const { amount, unit } = amountIn(order, currencySetting(settings.amountUnit, order.currency))

    const response = await gatewayFetch(
      `${descriptor.endpoints[context.mode].api}/request.json`,
      descriptor.allowedHosts,
      {
        body: {
          amount,
          callback_url: buildCallbackUrl(context),
          currency: unit,
          description: `سفارش ${order.reference} — ${order.productTitle}`.slice(0, 250),
          merchant_id: merchantId,
          // Optional, and the buyer's receipt SMS depends on it: `mobile` is how ZarinPal
          // addresses the confirmation text message.
          metadata: {
            ...(order.buyer.email ? { email: order.buyer.email } : {}),
            mobile: order.buyer.phone,
            order_id: order.reference,
          },
          ...(credentials.referrerId?.trim() ? { referrer_id: credentials.referrerId.trim() } : {}),
        },
        method: 'POST',
      },
      req,
    )

    const error = errorOf(response.json)
    const code = pick(response.json, 'data.code')

    if (error || Number(code) !== 100) {
      req.payload.logger.error({
        msg: `zarinpal: request.json refused for order ${order.id}`,
        zarinpal: { code, error },
      })

      throw new Error(`zarinpal request refused: ${error ?? `code ${code}`}`)
    }

    const authority = pick(response.json, 'data.authority')

    if (typeof authority !== 'string' || !authority) {
      throw new Error('zarinpal request returned no authority')
    }

    // The pay page is built, not returned: v4 answers with an `authority` and the buyer is
    // sent to StartPay with it. `pickUrl` first, so a future response that carries its own
    // redirect wins over a template we maintain.
    const redirectUrl =
      pickUrl(response.json, 'data.redirectUrl', 'data.payUrl') ??
      descriptor.endpoints[context.mode].pay?.replace('{token}', authority) ??
      null

    if (!redirectUrl) throw new Error('zarinpal: no pay URL could be built')

    return {
      data: {
        authority,
        fee: pick(response.json, 'data.fee') ?? undefined,
        feeType: pick(response.json, 'data.fee_type') ?? undefined,
      } satisfies GatewayResultData,
      paymentReference: authority,
      redirectUrl,
    }
  },

  confirm: async (context) => {
    const { callback, credentials, descriptor, order, paymentReference, req } = context

    // The authority we stored at initiate. The callback's own `Authority` is read only
    // when we have nothing stored — a buyer who returns without one gets "not verified",
    // never a lookup by a value they typed.
    const fromCallback = callback?.query?.Authority ?? callback?.query?.authority
    const authority =
      paymentReference ?? (typeof fromCallback === 'string' && fromCallback ? fromCallback : null)

    if (!authority) {
      return { ok: false, reason: 'کد پیگیری درگاه در دسترس نیست.' }
    }

    /**
     * `Status=NOK` is ZarinPal telling us the buyer cancelled or the bank declined. There
     * is nothing to verify, and calling `verify.json` anyway is how a cancelled attempt
     * turns into a `-21` in the logs that reads as a bug.
     *
     * The check is deliberately *not* the other way round: a missing `Status` still
     * verifies, because a PSP-initiated callback (as opposed to the browser's return) does
     * not always carry it, and the verify call is the authority either way.
     */
    const status = callback?.query?.Status ?? callback?.query?.status

    if (typeof status === 'string' && status.toUpperCase() === 'NOK') {
      return { data: { authority }, ok: false, reason: FAILED_OR_CANCELLED }
    }

    const { amount, unit } = amountIn(order, currencySetting(context.settings.amountUnit, order.currency))

    let response

    try {
      response = await gatewayFetch(
        `${descriptor.endpoints[context.mode].api}/verify.json`,
        descriptor.allowedHosts,
        { body: { amount, authority, currency: unit, merchant_id: credentials.merchantId }, method: 'POST' },
        req,
      )
    } catch (error) {
      req.payload.logger.error({
        err: error as Error,
        msg: `zarinpal: verify failed for order ${order.id}`,
      })

      return { ok: false, reason: 'ارتباط با درگاه برقرار نشد؛ دوباره تلاش کنید.' }
    }

    const error = errorOf(response.json)
    const code = pick(response.json, 'data.code')

    if (Number(code) === 100 || Number(code) === 101) {
      return {
        data: {
          authority,
          // Masked by ZarinPal itself (`603799******1234`). Stored for reconciliation
          // with the shop's own bank statement, which is the question a store owner
          // actually asks about a disputed order.
          cardPan: pick(response.json, 'data.card_pan') ?? undefined,
          fee: pick(response.json, 'data.fee') ?? undefined,
          refId: pick(response.json, 'data.ref_id') ?? undefined,
          verifiedTwice: Number(code) === 101 ? 'already-verified' : undefined,
        } satisfies GatewayResultData,
        ok: true,
        /**
         * Still the authority, never the `ref_id`. `orders.payment.reference` is what the
         * next `confirm()` call sends as `authority`, and overwriting it with the bank's
         * reference number would make a retry — the write failed, or ZarinPal called back
         * twice — verify a value it has never heard of.
         */
        paymentReference: authority,
      }
    }

    req.payload.logger.warn({
      msg: `zarinpal: verify refused for order ${order.id}`,
      zarinpal: { code, error },
    })

    return {
      data: { authority, code: code ?? undefined, error: error ?? undefined },
      ok: false,
      reason: error && ERROR_MESSAGES[String(code)] ? ERROR_MESSAGES[String(code)]! : FAILED_OR_CANCELLED,
    }
  },

  /**
   * `unVerified.json` is read-only, costs nothing and is authenticated by the merchant id
   * alone — so it is the cheapest honest answer to "is this credential real?". It does not
   * create a transaction, which is the rule `GatewayAdapter.healthCheck` sets.
   */
  healthCheck: async (context) => {
    const { credentials, descriptor, req } = context

    const response = await gatewayFetch(
      `${descriptor.endpoints[context.mode].api}/unVerified.json`,
      descriptor.allowedHosts,
      { body: { merchant_id: credentials.merchantId }, method: 'POST' },
      req,
    )

    const error = errorOf(response.json)

    return error
      ? { detail: error, ok: false }
      : {
          detail:
            response.json?.data && typeof response.json.data === 'object'
              ? `اعتبارنامه معتبر است؛ ${
                  Array.isArray((response.json.data as { authorities?: unknown }).authorities)
                    ? ((response.json.data as { authorities: unknown[] }).authorities.length)
                    : 0
                } تراکنش تأییدنشده در پنل.`
              : 'اعتبارنامه معتبر است.',
          ok: true,
        }
  },
}
