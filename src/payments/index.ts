import type { PaymentProvider } from './types'

import { bankProvider } from './bank'
import { httpProvider } from './http'

/**
 * Every way a site can take money, keyed by the value stored in
 * `store.paymentProvider` / `orders.payment.provider`.
 *
 * Two, not one, because the second is a placeholder with a job: `bank` is what most
 * small Iranian storefronts actually use, and it is also the provider the checkout
 * flow can be *tested* against — no credentials, no callback, no sandbox. Adding a
 * real PSP is a new file here plus its env vars; nothing in the order lifecycle
 * changes.
 *
 * Stripe is deliberately absent. It is what the original Wave 7 issue assumed, and
 * it is unavailable to this platform's customers: Iran is not a Stripe-supported
 * country for opening a merchant account, and `IRR`/`Toman` are not Stripe
 * presentment currencies — so "pay in Stripe" would be a checkbox that only a site
 * with a US entity could tick. It comes back as a third adapter the day a customer
 * with a foreign entity wants USD. See `WAVE-7.md`.
 */
export const paymentProviders: Record<PaymentProvider['name'], PaymentProvider> = {
  bank: bankProvider,
  http: httpProvider,
}

/** `select` options for the admin, in the platform's own order. */
export const paymentProviderOptions = Object.values(paymentProviders).map(
  ({ label, name }) => ({ label, value: name }),
)

/**
 * The provider a site actually gets. An unconfigured or misspelt value falls back to
 * `bank` rather than throwing: a broken `store` document must not take the storefront
 * down, and falling back to the method that can never move money falsely is the safe
 * direction.
 */
export const resolvePaymentProvider = (name: null | string | undefined): PaymentProvider =>
  paymentProviders[(name ?? 'bank') as PaymentProvider['name']] ?? bankProvider

export { PaymentGatewayNotConfigured } from './http'
export type {
  CheckoutOrder,
  PaymentProviderName,
  PaymentConfirmation,
  PaymentInitiation,
  PaymentProvider,
} from './types'
