import type { GatewayAdapter, GatewayResultData } from '../types'

import { amountIn, amountMatches } from '../amount'
import { authenticatedCall, bearerToken } from '../oauth'
import { gatewayFetch, pick, pickUrl } from '../net'

/**
 * Digipay — `mydigipay.com/developers/docs/upg`, the Unified Payment Gateway (UPG).
 *
 * ```
 * POST {api}/oauth/token                     Authorization: Basic base64(client_id:client_secret)
 *   form: username, password, grant_type=password
 *   → { access_token, refresh_token, token_type, expires_in }
 *
 * POST {api}/tickets/business?type=11        Authorization: Bearer …, Agent: WEB,
 *   { cellNumber, amount(Rial), providerId, callbackUrl,       Digipay-Version: 2022-02-02
 *     additionalInfo?: { preferredGateway }, basketDetailsDto? }
 *   → { result: { title, status, message, level }, ticket, redirectUrl }
 *
 * ← the buyer pays, then Digipay POSTs to callbackUrl:
 *   { amount, providerId, trackingCode, result: 'SUCCESS'|'FAILURE', type, rrn?, psp?, isCredit? }
 *
 * POST {api}/purchases/verify?type={type}    { trackingCode, providerId }
 * POST {api}/purchases/reverse?type={type}   { purchaseTrackingCode, providerId }   ← §8, manual refund
 * ```
 *
 * Four things about this provider shape the code:
 *
 * - **The ticket is not the payment.** `tickets/business` answers with a `ticket` and a
 *   `redirectUrl`; the money is only real once `purchases/verify` says so. And §7 is
 *   explicit that an unverified successful purchase is *automatically reversed* after a
 *   while — so `confirm` must always call verify, even when the callback already said
 *   `SUCCESS`.
 * - **Digipay's own docs demand the cross-check.** §7 opens with a warning to compare the
 *   callback's `amount` and `providerId` against your own transaction before verifying.
 *   That is not a suggestion the adapter can skip: verifying someone else's `trackingCode`
 *   against our merchant account is exactly how a paid-for-cheap order becomes paid-for.
 * - **`type` travels.** The ticket type we asked for (`?type=11`) is not necessarily the
 *   type of the purchase the buyer ended up making (they may pick Wallet on Digipay's own
 *   page and come back as `type=11`, or use credit and come back as `5`). The callback
 *   carries the real one and verify must be called with it, so it is stored on the order.
 * - **`amount` is Rial**, always. `amountIn(order, 'IRR')` and `tomanToRial()` are the only
 *   place the factor of ten lives.
 */

/** §12: Digipay answers `result.status: 0` for success on every service. */
const resultOk = (json: null | Record<string, unknown>): boolean => {
  const status = pick(json, 'result.status')
  const title = pick(json, 'result.title')

  return Number(status) === 0 || String(title ?? '').toUpperCase() === 'SUCCESS'
}

const resultMessage = (json: null | Record<string, unknown>): string =>
  String(pick(json, 'result.message') ?? 'پاسخ نامعتبر از دیجی‌پی')

/**
 * The headers §4/§5 require. `Digipay-Version` is a fixed protocol date in their docs,
 * not a build date — sending today's date is how an integration stops working.
 */
const serviceHeaders = (token: string): Record<string, string> => ({
  accept: 'application/json',
  agent: 'WEB',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json; charset=UTF-8',
  'digipay-version': '2022-02-02',
})

export const digipayAdapter: GatewayAdapter = {
  id: 'digipay',

  initiate: async (context) => {
    const { credentials, descriptor, order, req, settings } = context

    const base = (settings.baseUrl?.trim() || descriptor.endpoints[context.mode].api).replace(/\/+$/, '')
    const ticketType = (settings.ticketType || '11').trim()

    // Rial, unconditionally: Digipay has no `currency` field, so the site's unit has to be
    // converted here and there is no way for a row setting to change that.
    const { amount } = amountIn(order, 'IRR')

    const phone = order.buyer.phone

    if (!phone) {
      // `cellNumber` is mandatory (§5, table 5) and Digipay identifies the wallet by it.
      // Refusing here beats a 400 from the PSP that the buyer would read as an outage — and
      // the checkout form cannot hide the field on a site whose gateways all
      // `requiresMobile`, so reaching this line means somebody built a buyer payload
      // without one.
      throw new Error('digipay requires the buyer mobile number')
    }

    const oauth = {
      allowedHosts: descriptor.allowedHosts,
      clientId: credentials.clientId ?? '',
      clientSecret: credentials.clientSecret ?? '',
      key: `${context.rowId}:${context.mode}`,
      password: credentials.password ?? '',
      req,
      username: credentials.username ?? '',
      url: `${base}/oauth/token`,
    }

    const token = await bearerToken(oauth)

    /**
     * The basket, only when the row asks for one. §5 makes `basketDetailsDto` mandatory for
     * credit/BNPL purchases and the IPG/Wallet examples omit it entirely — so a blank
     * `basketCategoryId` means "no basket", and a filled one builds the single-item basket
     * this platform's one-line orders can honestly describe.
     */
    const basketCategoryId =
      settings.basketCategoryId && settings.basketCategoryId !== 'none'
        ? settings.basketCategoryId
        : null

    const basketDetailsDto = basketCategoryId
      ? {
          basketId: order.id,
          items: [
            {
              brand: settings.basketBrand?.trim() || order.site.name || 'general',
              categoryId: basketCategoryId,
              count: order.quantity,
              productCode: order.reference,
              productType: Number(settings.basketProductType || 1),
              ...(settings.sellerId?.trim() ? { sellerId: settings.sellerId.trim() } : {}),
              ...(settings.supplierId?.trim() ? { supplierId: settings.supplierId.trim() } : {}),
            },
          ],
        }
      : undefined

    // `'none'` is the explicit "let Digipay show its own chooser" option; `Number('none')`
    // is `NaN`, and a `NaN` in a JSON body is a 400 the buyer would read as an outage.
    const preferredGatewaySetting = settings.preferredGateway?.trim()
    const preferredGateway =
      preferredGatewaySetting && preferredGatewaySetting !== 'none'
        ? preferredGatewaySetting
        : null

    const response = await gatewayFetch(
      `${base}/tickets/business`,
      descriptor.allowedHosts,
      {
        body: {
          amount,
          ...(basketDetailsDto ? { basketDetailsDto } : {}),
          callbackUrl: context.callbackUrl,
          cellNumber: phone,
          // Our own unique id for the purchase (§5: "the unique id you register for this
          // purchase"). It is the order's uuid, which is what the callback echoes back and
          // what `confirm` cross-checks — a value the buyer cannot choose.
          providerId: order.id,
          ...(preferredGateway
            ? { additionalInfo: { preferredGateway: Number(preferredGateway) } }
            : {}),
        },
        headers: serviceHeaders(token),
        method: 'POST',
        query: { type: ticketType },
      },
      req,
    )

    const redirectUrl = pickUrl(response.json, 'redirectUrl', 'payUrl', 'result.redirectUrl')

    if (!response.ok || !resultOk(response.json) || !redirectUrl) {
      req.payload.logger.error({
        digipay: { message: resultMessage(response.json), status: response.status },
        msg: `digipay: ticket refused for order ${order.id}`,
      })

      throw new Error(`digipay ticket refused: ${resultMessage(response.json)}`)
    }

    const ticket = pick(response.json, 'ticket')

    return {
      data: {
        amountRial: amount,
        ticket: typeof ticket === 'string' ? ticket : undefined,
        ticketType,
      } satisfies GatewayResultData,
      paymentReference: typeof ticket === 'string' && ticket ? ticket : redirectUrl,
      redirectUrl,
    }
  },

  confirm: async (context) => {
    const { callback, credentials, descriptor, order, paymentReference, req, settings } = context

    const base = (settings.baseUrl?.trim() || descriptor.endpoints[context.mode].api).replace(/\/+$/, '')

    /**
     * Digipay POSTs a JSON body to `callbackUrl` (§6), but a buyer's browser can also land
     * there with the same fields in the query string. Both are read; neither is believed.
     */
    const source: Record<string, unknown> = { ...(callback?.query ?? {}), ...(callback?.body ?? {}) }

    const trackingCode = pick(source, 'trackingCode', 'tracking_code') ?? paymentReference
    const providerId = pick(source, 'providerId', 'provider_id')
    const result = pick(source, 'result')
    const callbackType = pick(source, 'type')

    if (!trackingCode) {
      return { ok: false, reason: 'کد پیگیری دیجی‌پی در دسترس نیست.' }
    }

    /**
     * §7's warning, implemented. Three cross-checks, all of which must pass before verify
     * is even called:
     *
     * - the purchase is *ours* — `providerId` is the order uuid we sent at initiate;
     * - the amount is *ours* — in Rial, compared against the order in Toman via
     *   `amountMatches`, so a Rial/Toman mix-up cannot read as a match;
     * - the outcome is a success — `FAILURE` is Digipay telling us the buyer did not pay.
     *
     * When the callback carries none of these (a browser return with only `?Status=OK`),
     * the checks are skipped rather than failed: there is nothing to compare, and
     * `purchases/verify` is still the authority.
     */
    if (providerId && String(providerId) !== String(order.id) && String(providerId) !== String(order.reference)) {
      req.payload.logger.warn({
        digipay: { got: String(providerId), want: String(order.id) },
        msg: `digipay: callback providerId does not match order ${order.id}`,
      })

      return { ok: false, reason: 'اطلاعات بازگشتی درگاه با این سفارش مطابقت ندارد.' }
    }

    const callbackAmount = pick(source, 'amount')

    if (callbackAmount !== null && !amountMatches(order, callbackAmount, 'IRR')) {
      req.payload.logger.warn({
        digipay: { got: String(callbackAmount) },
        msg: `digipay: callback amount does not match order ${order.id}`,
      })

      return { ok: false, reason: 'مبلغ پرداخت‌شده با مبلغ سفارش مطابقت ندارد.' }
    }

    if (result && String(result).toUpperCase() !== 'SUCCESS') {
      return {
        data: { result: String(result), trackingCode: String(trackingCode) },
        ok: false,
        reason: 'پرداخت ناموفق بود یا توسط شما لغو شد.',
      }
    }

    // The callback's `type` is the purchase the buyer actually made, which is not
    // necessarily the ticket type we opened (§6, table 18). Falling back to the row's
    // setting keeps a browser-only return working.
    const ticketType = String(callbackType ?? settings.ticketType ?? '11')

    let response

    try {
      response = await authenticatedCall(
        {
          allowedHosts: descriptor.allowedHosts,
          clientId: credentials.clientId ?? '',
          clientSecret: credentials.clientSecret ?? '',
          key: `${context.rowId}:${context.mode}`,
          password: credentials.password ?? '',
          req,
          username: credentials.username ?? '',
          url: `${base}/oauth/token`,
        },
        (token) =>
          gatewayFetch(
            `${base}/purchases/verify`,
            descriptor.allowedHosts,
            {
              body: { providerId: String(providerId ?? order.id), trackingCode: String(trackingCode) },
              headers: serviceHeaders(token),
              method: 'POST',
              query: { type: ticketType },
            },
            req,
          ),
      )
    } catch (error) {
      req.payload.logger.error({
        err: error as Error,
        msg: `digipay: verify failed for order ${order.id}`,
      })

      return { ok: false, reason: 'ارتباط با دیجی‌پی برقرار نشد؛ دوباره تلاش کنید.' }
    }

    if (!response.ok || !resultOk(response.json)) {
      req.payload.logger.warn({
        digipay: { message: resultMessage(response.json), status: response.status },
        msg: `digipay: verify refused for order ${order.id}`,
      })

      return {
        data: {
          message: resultMessage(response.json),
          ticketType,
          trackingCode: String(trackingCode),
        } satisfies GatewayResultData,
        ok: false,
        reason: resultMessage(response.json),
      }
    }

    return {
      data: {
        isCredit: typeof source.isCredit === 'boolean' ? String(source.isCredit) : undefined,
        psp: pick(source, 'psp.name', 'psp') ?? undefined,
        rrn: pick(source, 'rrn') ?? undefined,
        ticketType,
        trackingCode: String(trackingCode),
      } satisfies GatewayResultData,
      ok: true,
      // Still the gateway's own reference for this purchase — see the same note in the
      // ZarinPal adapter: overwriting it would break a retry of this very call.
      paymentReference: String(trackingCode),
    }
  },

  /**
   * §8 — بازگشت وجه خرید به صورت دستی. Only valid for IPG/DPG purchases, which Digipay
   * enforces on its side; a wallet or credit purchase answers with a refusal that is
   * surfaced verbatim rather than swallowed.
   *
   * Not called automatically. A store owner moving an order to `refunded` is a bookkeeping
   * act, and silently sending money back on a status change would refund orders the shop
   * only meant to mark. `POST /api/payments/:row/cancel` is the door, and it is staff-only.
   */
  cancel: async (context) => {
    const { callback, credentials, descriptor, order, paymentReference, req, settings } = context

    const base = (settings.baseUrl?.trim() || descriptor.endpoints[context.mode].api).replace(/\/+$/, '')
    const trackingCode = pick(callback?.body ?? {}, 'trackingCode') ?? paymentReference

    if (!trackingCode) {
      return { ok: false, reason: 'کد پیگیری دیجی‌پی برای عودت در دسترس نیست.' }
    }

    const response = await authenticatedCall(
      {
        allowedHosts: descriptor.allowedHosts,
        clientId: credentials.clientId ?? '',
        clientSecret: credentials.clientSecret ?? '',
        key: `${context.rowId}:${context.mode}`,
        password: credentials.password ?? '',
        req,
        username: credentials.username ?? '',
        url: `${base}/oauth/token`,
      },
      (token) =>
        gatewayFetch(
          `${base}/purchases/reverse`,
          descriptor.allowedHosts,
          {
            body: { providerId: String(order.id), purchaseTrackingCode: String(trackingCode) },
            headers: serviceHeaders(token),
            method: 'POST',
            query: { type: settings.ticketType || '11' },
          },
          req,
        ),
    )

    return response.ok && resultOk(response.json)
      ? { ok: true, paymentReference: String(trackingCode) }
      : { ok: false, reason: resultMessage(response.json) }
  },

  /**
   * The OAuth handshake is the health check: it proves all four credentials at once, is
   * read-only, and is the exact call every purchase starts with. A 401 here is the
   * merchant's password, not a network problem.
   */
  healthCheck: async (context) => {
    const { credentials, descriptor, req, settings } = context
    const base = (settings.baseUrl?.trim() || descriptor.endpoints[context.mode].api).replace(/\/+$/, '')

    try {
      await bearerToken({
        allowedHosts: descriptor.allowedHosts,
        clientId: credentials.clientId ?? '',
        clientSecret: credentials.clientSecret ?? '',
        // The row id is already unique per (site, gateway) — see `uniqueGatewayPerSite` —
        // so it makes a better cache key than a site id, and it is the one thing a probe
        // has when there is no order yet.
        key: `${context.rowId}:${context.mode}:health`,
        password: credentials.password ?? '',
        req,
        username: credentials.username ?? '',
        url: `${base}/oauth/token`,
      })

      return { detail: 'توکن احراز هویت دریافت شد؛ اعتبارنامه‌ها معتبرند.', ok: true }
    } catch (error) {
      return { detail: (error as Error).message, ok: false }
    }
  },
}
