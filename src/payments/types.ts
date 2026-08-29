import type { PayloadRequest } from 'payload'

import type { CurrencyCode } from '@/lib/money'
import type { Site } from '@/payload-types'

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
  /** Only ever `true` after the gateway has been asked, server to server. */
  ok: boolean
  paymentReference?: string
  /** Shown to the buyer. Persian first, per CLAUDE.md. */
  reason?: string
}

/** Which way a site takes money. The value stored on `store.paymentProvider`. */
export type PaymentProviderName = 'bank' | 'http'

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
    order: CheckoutOrder
    paymentReference?: string
    req: PayloadRequest
  }) => Promise<PaymentConfirmation>
  initiate: (args: { order: CheckoutOrder; req: PayloadRequest }) => Promise<PaymentInitiation>
  label: string
  name: PaymentProviderName
}
