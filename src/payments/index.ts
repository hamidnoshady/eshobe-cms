import type { PaymentProvider } from './types'
import type { GatewayId } from './gateways/types'

import { bankProvider } from './bank'
import { gatewayProviders } from './gateways'
import { httpProvider } from './http'

/**
 * Every way a site can take money, keyed by the value stored in
 * `store.paymentProvider` / `orders.payment.provider`.
 *
 * Two of these are *methods* — `bank` is card-to-card transfer, which is what most small
 * Iranian storefronts actually use, and `http` is the generic "POST to your own
 * settlement service" adapter a site with its own POS terminal plugs into. Neither can
 * falsely confirm a payment, which is also why `bank` is the fallback: a broken
 * configuration has to fail towards "nobody was charged" rather than "an order went paid".
 *
 * The other four are Iranian PSPs, one per gateway in `src/payments/gateways/registry.ts`.
 * They are registered beside the methods rather than behind a second lookup, so
 * `resolvePaymentProvider(order.payment.provider)` — the one call the checkout callback
 * makes — works for a ZarinPal order exactly as it does for a card-to-card one, and so a
 * site that only ever wants one PSP can name it on `store.paymentProvider` directly.
 *
 * A tenant that wants several at once does not use that select: it enables rows in
 * `payment-gateways` and the buyer picks (`src/endpoints/checkout.ts`).
 *
 * Stripe is deliberately absent. It is what the original Wave 7 issue assumed, and it is
 * unavailable to this platform's customers: Iran is not a Stripe-supported country for
 * opening a merchant account, and `IRR`/Toman are not Stripe presentment currencies — so
 * "pay in Stripe" would be a checkbox that only a site with a US entity could tick. It
 * comes back as another adapter the day a customer with a foreign entity wants USD.
 * See `WAVE-7.md`.
 */
export const paymentProviders: Record<PaymentProvider['name'], PaymentProvider> = {
  bank: bankProvider,
  http: httpProvider,
  ...gatewayProviders,
}

/** `select` options for the admin, in the platform's own order. */
export const paymentProviderOptions = Object.values(paymentProviders).map(({ label, name }) => ({
  label,
  value: name,
}))

/**
 * The provider a site actually gets. An unconfigured or misspelt value falls back to
 * `bank` rather than throwing: a broken `store` document must not take the storefront
 * down, and falling back to the method that can never move money falsely is the safe
 * direction.
 */
export const resolvePaymentProvider = (name: null | string | undefined): PaymentProvider =>
  paymentProviders[(name ?? 'bank') as PaymentProvider['name']] ?? bankProvider

/** Whether a provider name is one of the four PSPs rather than a payment *method*. */
export const isGatewayProvider = (name: null | string | undefined): name is GatewayId =>
  typeof name === 'string' && name in gatewayProviders

export { PaymentGatewayNotConfigured } from './http'
export * from './gateways'
export type {
  CheckoutOrder,
  PaymentCallback,
  PaymentProviderName,
  PaymentConfirmation,
  PaymentInitiation,
  PaymentProvider,
} from './types'
