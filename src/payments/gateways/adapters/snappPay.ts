import type { GatewayAdapter, GatewayProbeContext, GatewayResultData } from '../types'

import { amountIn, amountMatches } from '../amount'
import { authenticatedCall } from '../oauth'
import { gatewayFetch, joinUrl, pick, pickUrl } from '../net'

/**
 * Snapp!Pay — the merchant API on `*.snapppay.ir`, as published in the provider's own
 * integration packages (their technical PDF is issued per merchant, and the base URL and
 * hosted-page address in it vary, which is why both are row settings).
 *
 * ```
 * POST {api}/api/online/v1/oauth/token     Authorization: Basic base64(client_id:client_secret)
 *   form: grant_type=password, scope=online-merchant, username, password
 *   → { access_token, expires_in }
 *
 * GET  {api}/api/online/offer/v1/eligible?amount={rial}          ← is this amount financeable?
 *
 * POST {api}/api/online/payment/v1/token   Authorization: Bearer …
 *   { amount(rial), paymentMethodTypeDto: 'INSTALLMENT', returnURL, transactionId,
 *     externalSourceAmount: 0, discountAmount: 0, mobile?, cartList: [ { cartId,
 *     totalAmount, shippingAmount, isShipmentIncluded, taxAmount, isTaxIncluded,
 *     cartItems: [ { id, name, count, amount, category, commissionType } ] } ] }
 *   → { paymentToken, orderId, … }
 *
 * ← the buyer is sent to Snapp!Pay's hosted page with that token, then returns to returnURL
 *
 * POST {api}/api/online/payment/v1/verify   { paymentToken }
 * POST {api}/api/online/payment/v1/settle   { paymentToken }
 * POST {api}/api/online/payment/v1/revert   { paymentToken }   ← un-settle a verified payment
 * POST {api}/api/online/payment/v1/cancel   { paymentToken }   ← void a token never paid
 * GET  {api}/api/online/payment/v1/status?paymentToken=…
 * ```
 *
 * ## Verify *and* settle, in that order
 *
 * This is the one provider here whose confirmation is two calls. `verify` asks Snapp!Pay
 * whether the buyer's instalment agreement went through; `settle` is the capture that
 * actually books the merchant's money. A verify without a settle leaves the order
 * authorized and unpaid, and the provider releases it later — so an adapter that marked
 * the order `paid` on verify alone would be recording money that never arrives.
 *
 * The failure that follows is the interesting one: **verify succeeded, settle failed.**
 * The buyer has agreed to pay and the shop has not been paid. That is answered as
 * `ok: false` with the reason spelled out and both facts stored in `gatewayData`, because
 * marking it paid would be a lie and marking it merely failed would lose the authorization.
 * The callback endpoint is idempotent, so a retry settles without re-verifying into a
 * second charge.
 *
 * ## Amounts
 *
 * Rial, always — the packages convert with the same `convertPrice(…, Currency::RIAL)` this
 * adapter routes through `amountIn(order, 'IRR')`. Snapp!Pay also enforces a *minimum*
 * financeable amount, so `minAmountRial` is a row setting and `resolve.ts` refuses to offer
 * the gateway below it rather than letting a buyer discover that at the PSP's page.
 */

/** Snapp!Pay's own floor for an instalment purchase, in Rial (۱۰۰٬۰۰۰ تومان). */
const DEFAULT_MIN_AMOUNT_RIAL = 1_000_000

const PATHS = {
  cancel: 'api/online/payment/v1/cancel',
  eligible: 'api/online/offer/v1/eligible',
  oauth: 'api/online/v1/oauth/token',
  revert: 'api/online/payment/v1/revert',
  settle: 'api/online/payment/v1/settle',
  status: 'api/online/payment/v1/status',
  token: 'api/online/payment/v1/token',
  verify: 'api/online/payment/v1/verify',
} as const

/** Every marker this API is known to answer a successful call with. */
const SUCCESS = new Set(['PAID', 'SETTLED', 'SUCCESS', 'SUCCESSFUL', 'VERIFIED'])

/** `status: 'error'` is how the provider reports a refused call, at any HTTP status. */
const isError = (json: null | Record<string, unknown>): boolean =>
  String(pick(json, 'status') ?? '').toLowerCase() === 'error'

const isSuccess = (json: null | Record<string, unknown>): boolean =>
  SUCCESS.has(String(pick(json, 'status', 'result.status', 'result') ?? '').toUpperCase())

const messageOf = (json: null | Record<string, unknown>): null | string => {
  const message = pick(json, 'message', 'result.message', 'error')

  return typeof message === 'string' && message ? message : null
}

const baseUrlOf = (context: GatewayProbeContext): string =>
  (context.settings.baseUrl?.trim() || context.descriptor.endpoints[context.mode].api).replace(
    /\/+$/,
    '',
  )

const oauthArgs = (context: GatewayProbeContext) => ({
  allowedHosts: context.descriptor.allowedHosts,
  clientId: context.credentials.clientId ?? '',
  clientSecret: context.credentials.clientSecret ?? '',
  // Unique per (site, gateway) by `uniqueGatewayPerSite`, so it needs no site id — and a
  // probe, which has no order, can share the cache with a real attempt on the same row.
  key: `${context.rowId}:${context.mode}`,
  password: context.credentials.password ?? '',
  req: context.req,
  // Their packages send this scope on the password grant; without it the token is issued
  // but rejected by the payment services.
  scope: 'online-merchant',
  url: joinUrl(baseUrlOf(context), PATHS.oauth),
  username: context.credentials.username ?? '',
})

/** The minimum this row will finance, in Rial. */
export const minAmountRialFor = (settings: Record<string, string>): number => {
  const configured = Number(settings.minAmountRial)

  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MIN_AMOUNT_RIAL
}

export const snappPayAdapter: GatewayAdapter = {
  id: 'snappPay',

  initiate: async (context) => {
    const { descriptor, order, req, settings } = context

    const { amount } = amountIn(order, 'IRR')
    const minimum = minAmountRialFor(settings)

    if (amount < minimum) {
      // Thrown, not returned: `initiate`'s contract is a redirect or an error, and this is
      // an error the storefront can prevent by not offering the gateway (see `resolve.ts`).
      throw new Error(`snappPay amount ${amount} below provider minimum ${minimum}`)
    }

    const phone = order.buyer.phone

    if (!phone) throw new Error('snappPay requires the buyer mobile number')

    const response = await authenticatedCall(oauthArgs(context), (token) =>
      gatewayFetch(
        joinUrl(baseUrlOf(context), PATHS.token),
        descriptor.allowedHosts,
        {
          body: {
            amount,
            cartList: [
              {
                cartId: order.id,
                cartItems: [
                  {
                    amount,
                    category: order.productTitle || 'general',
                    commissionType: Number(settings.commissionType?.trim() || 1),
                    count: order.quantity,
                    id: order.reference,
                    name: order.productTitle || `سفارش ${order.reference}`,
                  },
                ],
                isShipmentIncluded: false,
                isTaxIncluded: false,
                shippingAmount: 0,
                taxAmount: 0,
                totalAmount: amount,
              },
            ],
            discountAmount: 0,
            externalSourceAmount: 0,
            mobile: phone,
            paymentMethodTypeDto: 'INSTALLMENT',
            returnURL: context.callbackUrl,
            transactionId: String(order.id),
          },
          headers: { authorization: `Bearer ${token}` },
          method: 'POST',
        },
        req,
      ),
    )

    const paymentToken = pick(response.json, 'paymentToken', 'token', 'data.paymentToken')

    if (!response.ok || isError(response.json) || typeof paymentToken !== 'string' || !paymentToken) {
      req.payload.logger.error({
        msg: `snappPay: token refused for order ${order.id}`,
        snappPay: { message: messageOf(response.json), status: response.status },
      })

      throw new Error(`snappPay token refused: ${messageOf(response.json) ?? response.status}`)
    }

    /**
     * The hosted page. If the response carries its own URL it wins — Snapp!Pay changes that
     * address between environments and per merchant — and the row's `payPageUrl` template is
     * the fallback for a response that only hands back a token.
     */
    const redirectUrl =
      pickUrl(response.json, 'redirectUrl', 'payUrl', 'url', 'h5Url', 'data.redirectUrl') ??
      (settings.payPageUrl?.trim() || descriptor.endpoints[context.mode].pay || '').replace(
        '{token}',
        paymentToken,
      )

    if (!redirectUrl) throw new Error('snappPay: no payment page URL could be built')

    return {
      data: {
        amountRial: amount,
        orderId: pick(response.json, 'orderId', 'data.orderId') ?? undefined,
        paymentToken,
      } satisfies GatewayResultData,
      paymentReference: paymentToken,
      redirectUrl,
    }
  },

  confirm: async (context) => {
    const { callback, descriptor, order, paymentReference, req } = context

    const token =
      paymentReference ?? pick(callback?.body ?? {}, 'paymentToken', 'token') ?? null

    if (!token) {
      return { ok: false, reason: 'توکن پرداخت اسنپ‌پی در دسترس نیست.' }
    }

    const call = (path: string, method: 'GET' | 'POST') => (bearer: string) =>
      gatewayFetch(
        joinUrl(baseUrlOf(context), path),
        descriptor.allowedHosts,
        {
          ...(method === 'GET' ? { query: { paymentToken: String(token) } } : { body: { paymentToken: String(token) } }),
          headers: { authorization: `Bearer ${bearer}` },
          method,
        },
        req,
      )

    let verified

    try {
      verified = await authenticatedCall(oauthArgs(context), call(PATHS.verify, 'POST'))
    } catch (error) {
      req.payload.logger.error({
        err: error as Error,
        msg: `snappPay: verify failed for order ${order.id}`,
      })

      return { ok: false, reason: 'ارتباط با اسنپ‌پی برقرار نشد؛ دوباره تلاش کنید.' }
    }

    if (!verified.ok || isError(verified.json) || !isSuccess(verified.json)) {
      req.payload.logger.warn({
        msg: `snappPay: verify refused for order ${order.id}`,
        snappPay: { message: messageOf(verified.json), status: verified.status },
      })

      return {
        data: {
          message: messageOf(verified.json) ?? undefined,
          paymentToken: String(token),
        } satisfies GatewayResultData,
        ok: false,
        reason:
          messageOf(verified.json) && !isError(verified.json)
            ? messageOf(verified.json)!
            : 'پرداخت توسط اسنپ‌پی تأیید نشد.',
      }
    }

    /**
     * The verify response echoes the financed amount. When it does, it is compared — a
     * token verified against a different order's amount is the failure mode a
     * `paymentToken` in a query string makes possible, and `amountMatches` normalises the
     * Rial figure to the order's own unit before comparing.
     */
    const verifiedAmount = pick(verified.json, 'amount', 'totalAmount', 'data.amount')

    if (verifiedAmount !== null && !amountMatches(order, verifiedAmount, 'IRR')) {
      req.payload.logger.error({
        msg: `snappPay: verified amount does not match order ${order.id}`,
        snappPay: { got: String(verifiedAmount) },
      })

      return { ok: false, reason: 'مبلغ تأییدشده با مبلغ سفارش مطابقت ندارد.' }
    }

    let settled

    try {
      settled = await authenticatedCall(oauthArgs(context), call(PATHS.settle, 'POST'))
    } catch (error) {
      req.payload.logger.error({
        err: error as Error,
        msg: `snappPay: settle failed for order ${order.id} AFTER a successful verify`,
      })

      return {
        data: {
          message: (error as Error).message,
          paymentToken: String(token),
          settle: 'failed-after-verify',
        } satisfies GatewayResultData,
        ok: false,
        reason:
          'پرداخت تأیید شد اما تسویه با اسنپ‌پی انجام نشد. سفارش را دوباره تأیید کنید؛ اگر تکرار شد با فروشگاه تماس بگیرید.',
      }
    }

    if (!settled.ok || isError(settled.json)) {
      req.payload.logger.error({
        msg: `snappPay: settle refused for order ${order.id} AFTER a successful verify`,
        snappPay: { message: messageOf(settled.json), status: settled.status },
      })

      return {
        data: {
          message: messageOf(settled.json) ?? undefined,
          paymentToken: String(token),
          settle: 'refused-after-verify',
        } satisfies GatewayResultData,
        ok: false,
        reason:
          'پرداخت تأیید شد اما تسویه با اسنپ‌پی انجام نشد. سفارش را دوباره تأیید کنید؛ اگر تکرار شد با فروشگاه تماس بگیرید.',
      }
    }

    return {
      data: {
        orderId: pick(verified.json, 'orderId', 'data.orderId') ?? undefined,
        paymentToken: String(token),
        settle: 'ok',
        settleOrderId: pick(settled.json, 'orderId', 'settleId') ?? undefined,
        wage: pick(verified.json, 'wage', 'data.wage') ?? undefined,
      } satisfies GatewayResultData,
      ok: true,
      paymentReference: String(token),
    }
  },

  /**
   * `revert` undoes a settled payment, `cancel` voids a token that was never paid. Which
   * one is right depends on how far the attempt got, and this adapter knows that from what
   * it stored at confirm — so it tries `revert` first and falls back to `cancel`, reporting
   * whichever answer came from Snapp!Pay rather than guessing.
   */
  cancel: async (context) => {
    const { descriptor, paymentReference, req } = context

    if (!paymentReference) {
      return { ok: false, reason: 'توکن پرداخت اسنپ‌پی برای لغو در دسترس نیست.' }
    }

    const attempt = async (path: string) =>
      authenticatedCall(oauthArgs(context), (bearer) =>
        gatewayFetch(
          joinUrl(baseUrlOf(context), path),
          descriptor.allowedHosts,
          {
            body: { paymentToken: String(paymentReference) },
            headers: { authorization: `Bearer ${bearer}` },
            method: 'POST',
          },
          req,
        ),
      )

    const reverted = await attempt(PATHS.revert).catch(() => null)

    if (reverted?.ok && !isError(reverted.json)) {
      return { ok: true, paymentReference: String(paymentReference) }
    }

    const cancelled = await attempt(PATHS.cancel).catch(() => null)

    if (cancelled?.ok && !isError(cancelled.json)) {
      return { ok: true, paymentReference: String(paymentReference) }
    }

    return {
      ok: false,
      reason:
        messageOf(reverted?.json ?? null) ??
        messageOf(cancelled?.json ?? null) ??
        'اسنپ‌پی لغو این تراکنش را نپذیرفت.',
    }
  },

  /**
   * `eligible` is a read-only GET that exercises the whole credential chain — OAuth, scope,
   * merchant status — at the minimum amount, so it cannot create anything and cannot be
   * mistaken for a real purchase.
   */
  healthCheck: async (context) => {
    const { descriptor, req, settings } = context

    try {
      const response = await authenticatedCall(oauthArgs(context), (bearer) =>
        gatewayFetch(
          joinUrl(baseUrlOf(context), PATHS.eligible),
          descriptor.allowedHosts,
          {
            headers: { authorization: `Bearer ${bearer}` },
            method: 'GET',
            query: { amount: minAmountRialFor(settings) },
          },
          req,
        ),
      )

      if (!response.ok || isError(response.json)) {
        return { detail: messageOf(response.json) ?? `HTTP ${response.status}`, ok: false }
      }

      return {
        detail: `اعتبارنامه‌ها معتبرند؛ حداقل مبلغ قابل تقسیط ${minAmountRialFor(settings)} ریال پرسیده شد.`,
        ok: true,
      }
    } catch (error) {
      return { detail: (error as Error).message, ok: false }
    }
  },
}
