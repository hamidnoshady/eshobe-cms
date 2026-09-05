import type { PayloadRequest } from 'payload'

import type { CurrencyCode } from '@/lib/money'
import type { CheckoutOrder, PaymentConfirmation, PaymentInitiation } from '../types'

/**
 * The contract one Iranian PSP has to satisfy to be a gateway on this platform.
 *
 * Every gateway in `src/payments/gateways/adapters/` makes the same four moves — open a
 * transaction, send the buyer to a URL, read what came back, ask the PSP itself whether
 * the money moved — and every difference between ZarinPal, Digipay, Snapp!Pay and Torob
 * Pay is a difference in *field names and auth*, not in that shape. So the shape lives
 * here and each adapter is a translation.
 *
 * Two rules are load-bearing:
 *
 * 1. **The credentials are not env vars.** They belong to one tenant and are decrypted
 *    per call, so `GatewayContext.credentials` is the only place a plaintext secret
 *    exists. Nothing in an adapter may log it: `net.ts` redacts request headers and
 *    bodies, and `resolve.ts` never puts a value into an error message.
 * 2. **`confirm` answers from the PSP, never from the callback.** `callback` below is
 *    what the buyer's browser or the PSP's server handed us. It is read for *lookups*
 *    (which attempt is this?) and *cross-checks* (does the amount match the order?), and
 *    it is never the reason an order becomes `paid`.
 */

/** The value stored on `payment-gateways.gateway` and on `orders.payment.provider`. */
export type GatewayId = 'digipay' | 'snappPay' | 'torobPay' | 'zarinpal'

/** Which of the PSP's environments a tenant's row points at. */
export type GatewayMode = 'live' | 'sandbox'

/** A credential or technical setting one gateway needs, by key. Wording lives in `registry.ts`. */
export type GatewayConfigRef = { key: string; required?: boolean }

export type GatewayEndpoints = {
  /** Base URL of the PSP's REST API, no trailing slash. */
  api: string
  /**
   * Where the buyer's browser goes to pay, when the adapter has to build that URL itself
   * instead of reading it out of the API response. `{token}` is replaced with whatever
   * the PSP returned.
   */
  pay?: string
}

export type GatewayDescriptor = {
  /** Host suffixes this gateway may ever be called on — the SSRF allowlist (`net.ts`). */
  allowedHosts: string[]
  /** Persian one-liner shown under the gateway in the admin's picker and on the storefront. */
  blurb: string
  credentials: GatewayConfigRef[]
  /** Units this PSP can settle in. An Iranian gateway is `['IRT', 'IRR']`, full stop. */
  currencies: CurrencyCode[]
  docsUrl: string
  endpoints: Record<GatewayMode, GatewayEndpoints>
  id: GatewayId
  /**
   * `psp` takes a card now; `bnpl` is an instalment/credit product where the provider
   * pays the merchant. It reaches the storefront as a hint («پرداخت اقساطی») and decides
   * the default copy — nothing about the money depends on it.
   */
  kind: 'bnpl' | 'psp'
  label: string
  labelEn: string
  /** A buyer's mobile number is mandatory, so the checkout form may not hide the field. */
  requiresMobile: boolean
  settings: GatewayConfigRef[]
}

/** Everything an adapter is told about one attempt. Read-only by construction. */
export type GatewayContext = {
  /**
   * What the buyer's browser or the PSP's callback server sent. Lookups and
   * cross-checks only — see rule 2 at the top of this file.
   */
  callback?: { body: Record<string, unknown>; query: Record<string, unknown> }
  /** The URL the PSP sends the buyer (or its own server) back to. Absolute, on the site's domain. */
  callbackUrl: string
  /** Decrypted credential values, keyed by `descriptor.credentials[].key`. */
  credentials: Record<string, string>
  descriptor: GatewayDescriptor
  mode: GatewayMode
  order: CheckoutOrder
  /** The gateway's own reference for this attempt, as stored on the order at initiate. */
  paymentReference?: string
  req: PayloadRequest
  /** Non-secret technical settings, keyed by `descriptor.settings[].key`. */
  settings: Record<string, string>
  /** The `payment-gateways` row id, for logging and for writing reconciliation data back. */
  rowId: string
}

/**
 * What a `healthCheck` is given: everything about the *configuration*, nothing about an
 * attempt. There is no order, no callback and no callback URL, because the probe's whole
 * job is to answer "are these credentials real?" before anybody buys anything — and a
 * signature that demanded an order would have to be handed a fabricated one.
 *
 * A full `GatewayContext` satisfies this type, so the helpers an adapter shares between
 * `initiate` and `healthCheck` take this one and work for both.
 */
export type GatewayProbeContext = Omit<
  GatewayContext,
  'callback' | 'callbackUrl' | 'order' | 'paymentReference'
>

/**
 * Extra facts an adapter wants kept on the order for reconciliation — Digipay's
 * `trackingCode` and ticket `type`, ZarinPal's `ref_id` and masked card, Snapp!Pay's
 * `orderId`. Stored in `orders.payment.gatewayData` (staff-readable JSON), because
 * "the PSP's panel says paid, we say pending" is unanswerable without it.
 */
export type GatewayResultData = Record<string, null | number | string | undefined>

export type GatewayAdapter = {
  /**
   * Reverse or cancel an attempt. Optional: not every provider offers it, and an adapter
   * that invented one would be worse than an adapter that says it cannot. Called when a
   * store owner moves a `paid` order to `refunded`.
   */
  cancel?: (context: GatewayContext) => Promise<PaymentConfirmation>
  confirm: (context: GatewayContext) => Promise<PaymentConfirmation & { data?: GatewayResultData }>
  /**
   * A cheap, read-only "are these credentials real?" probe for the admin's self-test.
   * Must not create a transaction: it runs against a live merchant account.
   */
  healthCheck?: (context: GatewayProbeContext) => Promise<{ detail?: string; ok: boolean }>
  id: GatewayId
  initiate: (context: GatewayContext) => Promise<PaymentInitiation & { data?: GatewayResultData }>
}

/** `IRT`/`IRR` are the only units an Iranian PSP settles in. */
export const isIranianCurrency = (code: CurrencyCode | string): boolean =>
  code === 'IRR' || code === 'IRT'
