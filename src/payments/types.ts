import type { PayloadRequest } from 'payload'

import type { CurrencyCode } from '@/lib/money'
import type { Site } from '@/payload-types'
import type { GatewayId } from './gateways/types'

/**
 * The slice of an order a gateway needs. Deliberately not the whole document: the
 * provider must not be able to rewrite a buyer's details, and the fewer fields it
 * sees the less there is to leak into somebody else's API logs.
 *
 * `total` is in the site's minor currency unit, like everything else in money-land
 * (`src/lib/money.ts`).
 */
export type CheckoutOrder = {
  buyer: { email?: string; name: string; phone: string }
  currency: CurrencyCode
  id: string
  locale: string
  productTitle: string
  quantity: number
  reference: string
  /**
   * The whole site doc, because a callback URL has to be built on *the site's*
   * origin and only `sites.domain` + `sites.defaultLocale` say what that is
   * (`src/lib/site-url.ts` owns the rule). Providers read; they never write.
   */
  site: Site
  total: number
}

export type PaymentInitiation = {
  /**
   * Which environment the attempt was made in, snapshotted onto `orders.payment.mode`.
   * Only the four PSPs set it — `bank` and `http` have no sandbox — and it is a snapshot
   * because the gateway row can be flipped to `live` afterwards, and an order taken in
   * sandbox has to keep saying so.
   */
  mode?: 'live' | 'sandbox'
  /**
   * Facts the provider wants kept on the order for reconciliation — Digipay's ticket,
   * ZarinPal's authority and fee, Snapp!Pay's `orderId`. Written to
   * `orders.payment.gatewayData` (staff-readable JSON), because "the PSP's panel says paid
   * and we say pending" is unanswerable without them.
   */
  data?: Record<string, null | number | string | undefined>
  /**
   * The gateway's own id for the attempt, kept on the order so a discrepancy can be
   * reconciled against the PSP's panel later.
   */
  paymentReference?: string
  /**
   * Where to send the browser. Absent means "there is nothing to pay online" — the
   * checkout flow goes straight to the confirmation page instead.
   */
  redirectUrl?: null | string
}

export type PaymentConfirmation = {
  /** See `PaymentInitiation.data`. On a refusal this holds what the provider said, which
   * is the only record of *why* an order is still `pending`. */
  data?: Record<string, null | number | string | undefined>
  /** Only ever `true` after the gateway has been asked, server to server. */
  ok: boolean
  paymentReference?: string
  /** Shown to the buyer. Persian first, per CLAUDE.md. */
  reason?: string
}

/**
 * What the buyer's browser, or the PSP's callback server, handed back.
 *
 * Passed to `confirm` so an adapter can look the attempt up (`authority`, `trackingCode`)
 * and cross-check it (`amount`, `providerId`) — and read for nothing else. `CLAUDE.md`'s
 * rule and every adapter's header comment say the same thing: a value from a query string
 * is not evidence that money moved.
 */
export type PaymentCallback = { body: Record<string, unknown>; query: Record<string, unknown> }

/**
 * Which way a site takes money. The value stored on `store.paymentProvider` and on
 * `orders.payment.provider`.
 *
 * Two of these are methods (`bank`, `http`) and four are Iranian PSPs, one per gateway in
 * `src/payments/gateways/registry.ts`. They share a type because they share a lifecycle: an
 * order names one, the checkout endpoint resolves one, and the callback verifies against the
 * one the order named. Keeping the gateways out of this union would have meant a second
 * parallel field on every order and two code paths through the same lifecycle.
 */
export type PaymentProviderName = 'bank' | 'http' | GatewayId

/**
 * One way for a site to take money.
 *
 * The shape follows `@payloadcms/plugin-ecommerce`'s own `PaymentAdapter` — a
 * `name`, a label, an initiate step and a confirm step, with the gateway's extra
 * routes hanging off the same object — so that if the plugin is ever adopted for
 * its catalogue, the adapters written against this interface move with it. The
 * Wave 7 spike (`WAVE-7.md`) rejected the plugin's *collections*; this is the one
 * part of its design worth keeping.
 */
export type PaymentProvider = {
  /**
   * Server-to-server verification of a payment the browser claims to have made.
   *
   * Optional because not every method can be verified automatically: a card-to-card
   * transfer is confirmed by a human marking the order paid, and pretending
   * otherwise would mean trusting the buyer's redirect.
   */
  confirm?: (args: {
    /** What came back from the gateway or the buyer. Lookups and cross-checks only. */
    callback?: PaymentCallback
    order: CheckoutOrder
    paymentReference?: string
    req: PayloadRequest
  }) => Promise<PaymentConfirmation>
  initiate: (args: { order: CheckoutOrder; req: PayloadRequest }) => Promise<PaymentInitiation>
  label: string
  name: PaymentProviderName
}
