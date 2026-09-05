import type { PayloadRequest, TypedLocale } from 'payload'

import type { CheckoutOrder, PaymentCallback, PaymentProvider } from '../types'
import type { GatewayContext, GatewayId } from './types'
import type { GatewayResolution } from './resolve'

import { PaymentGatewayNotConfigured } from '../http'

import { gatewayAdapters } from './adapters'
import { gatewayDescriptors, isGatewayId } from './registry'
import { checkoutCallbackUrl, resolveGateway } from './resolve'

/**
 * The bridge: one `PaymentProvider` per gateway, so the four PSPs slot into the order
 * lifecycle that already exists instead of running beside it.
 *
 * `src/payments/types.ts` documents why the adapter shape mirrors
 * `@payloadcms/plugin-ecommerce`'s `PaymentAdapter`, and `src/endpoints/checkout.ts` is
 * written against `PaymentProvider` alone — it resolves a provider by name, calls
 * `initiate`, stores the reference, and calls `confirm` on the callback. Nothing in that
 * file knows which provider it is holding, which is what makes adding ZarinPal, Digipay,
 * Snapp!Pay and Torob Pay a matter of registering four objects rather than editing a
 * checkout flow.
 *
 * What the bridge adds, per call:
 *
 * 1. **Resolve the tenant's row** — module switch, platform allowlist, `enabled`, complete
 *    credentials, amount window — and refuse with the Persian reason if any of it fails.
 * 2. **Decrypt** the credentials for exactly this request, and pass them to the adapter in a
 *    context object they never outlive.
 * 3. **Build the callback URL** on the site's own origin, signed, so the tenant is
 *    re-resolvable from `Host` and the attempt cannot be re-routed.
 *
 * It does *not* decide whether the payment succeeded. That is the adapter's `confirm`, which
 * asks the PSP.
 */

/**
 * Shared by `initiate`, `confirm` and `POST /api/payments/cancel`, so the three paths that
 * talk to a PSP hand it the same shape.
 */
export const buildContext = ({
  callback,
  order,
  paymentReference,
  req,
  resolution,
}: {
  callback?: PaymentCallback
  order: CheckoutOrder
  paymentReference?: string
  req: PayloadRequest
  resolution: Extract<GatewayResolution, { ok: true }>
}): GatewayContext => ({
  ...(callback ? { callback } : {}),
  callbackUrl: checkoutCallbackUrl({ gateway: resolution.gateway.descriptor.id, order, req }),
  credentials: resolution.gateway.credentials,
  descriptor: resolution.gateway.descriptor,
  mode: resolution.gateway.mode,
  order,
  ...(paymentReference ? { paymentReference } : {}),
  req,
  rowId: resolution.gateway.rowId,
  settings: resolution.gateway.settings,
})

/**
 * `PaymentGatewayNotConfigured` is what `src/endpoints/checkout.ts` already checks for when
 * it decides between "this site's gateway is not configured" and "the gateway did not
 * answer". A gateway with a disabled row, missing credentials or an out-of-window amount is
 * the first of those, not the second — and the difference is which of two Persian sentences
 * the buyer reads. It is thrown inline rather than through a helper so the union narrows:
 * `resolution` is `GatewayResolution` until TypeScript has seen the `throw`, and a
 * never-returning helper does not reliably tell it so.
 */
export const gatewayProvider = (id: GatewayId): PaymentProvider => {
  const descriptor = gatewayDescriptors[id]

  return {
    name: id,
    label: descriptor.label,

    initiate: async ({ order, req }) => {
      if (!isGatewayId(id)) throw new PaymentGatewayNotConfigured()

      const resolution = await resolveGateway({
        amount: order.total,
        currency: order.currency,
        gateway: id,
        locale: order.locale as TypedLocale,
        req,
        siteId: String(order.site.id),
      })

      if (!resolution.ok) throw new PaymentGatewayNotConfigured(resolution.reason)

      const adapter = gatewayAdapters[id]
      const context = buildContext({ order, req, resolution })

      try {
        const result = await adapter.initiate(context)

        return {
          ...(result.data ? { data: result.data } : {}),
          mode: resolution.gateway.mode,
          paymentReference: result.paymentReference,
          redirectUrl: result.redirectUrl,
        }
      } catch (error) {
        // The adapter's own message (which may quote a PSP's refusal) goes to the log; the
        // buyer gets the generic sentence the checkout endpoint already writes.
        req.payload.logger.error({
          err: error as Error,
          gateway: id,
          msg: `payment gateway ${id}: initiate failed for order ${order.id}`,
        })

        throw error
      }
    },

    confirm: async ({ callback, order, paymentReference, req }) => {
      const resolution = await resolveGateway({
        // No amount window on confirm. The buyer already committed and the money may already
        // have moved: refusing to *verify* a payment because the row's maximum was lowered a
        // minute ago would strand it, and the amount is checked against the order by the
        // adapter anyway.
        currency: order.currency,
        gateway: id,
        locale: order.locale as TypedLocale,
        req,
        siteId: String(order.site.id),
      })

      if (!resolution.ok) {
        return {
          ok: false,
          reason:
            resolution.reason === 'پرداخت آنلاین در حال حاضر غیرفعال است.'
              ? // A platform-wide kill switch does not get to abandon an in-flight payment.
                // The module being off stops *new* attempts; this one exists.
                'درگاه پرداخت غیرفعال شده است؛ سفارش شما ثبت شده و فروشگاه آن را پیگیری می‌کند.'
              : resolution.reason,
        }
      }

      const adapter = gatewayAdapters[id]
      const context = buildContext({ callback, order, paymentReference, req, resolution })

      if (!adapter.confirm) return { ok: false, reason: 'این درگاه تأیید خودکار ندارد.' }

      try {
        const result = await adapter.confirm(context)

        return { ...(result.data ? { data: result.data } : {}), ok: result.ok, paymentReference: result.paymentReference, reason: result.reason }
      } catch (error) {
        req.payload.logger.error({
          err: error as Error,
          gateway: id,
          msg: `payment gateway ${id}: confirm failed for order ${order.id}`,
        })

        return { ok: false, reason: 'ارتباط با درگاه برقرار نشد؛ دوباره تلاش کنید.' }
      }
    },
  }
}

/** All four, keyed the way `store.paymentProvider` and `orders.payment.provider` store them. */
export const gatewayProviders: Record<GatewayId, PaymentProvider> = {
  digipay: gatewayProvider('digipay'),
  snappPay: gatewayProvider('snappPay'),
  torobPay: gatewayProvider('torobPay'),
  zarinpal: gatewayProvider('zarinpal'),
}

export { gatewayAdapters } from './adapters'
export * from './registry'
export * from './resolve'
export * from './types'
export {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  isEncrypted,
  signGatewayState,
  verifyGatewayState,
} from './crypto'
export { assertSafeGatewayUrl, gatewayFetch, isPrivateAddress, joinUrl } from './net'
export { amountIn, amountMatches } from './amount'
export { resetBearerTokens } from './oauth'
