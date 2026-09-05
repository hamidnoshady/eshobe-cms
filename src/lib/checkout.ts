import type { CheckoutOrder } from '@/payments'
import type { Order, Site } from '@/payload-types'

/**
 * The one number every part of a purchase agrees on.
 *
 * The product card's input, the order field's `max` and the checkout endpoint's
 * validator all enforce the same cap, and three copies of `99` is three chances for
 * one of them to move on its own: an input that allows 200 against a schema that
 * rejects it is a form that fails with a database error, and a schema that allows
 * more than the endpoint does is a rule nobody can rely on.
 */
export const MAX_ORDER_QUANTITY = 99

/**
 * One gateway a buyer may choose from, as the storefront sees it.
 *
 * Structurally the same as `EnabledGateway` in `src/payments/gateways/resolve.ts` and
 * deliberately not imported from it: that module loads `@payload-config` and `node:crypto`,
 * and `PurchaseForm` is a client component — importing the type would drag the Payload
 * config into the browser bundle for a shape that is five strings and three numbers.
 *
 * What is *not* here matters as much as what is: no row id, no credential of any kind, no
 * site id. A gateway's label, its blurb, its amount window and whether it needs the buyer's
 * mobile number is everything a picker can honestly render.
 */
export type PaymentMethodOption = {
  /** Persian one-liner from the gateway's descriptor. */
  blurb: string
  /** The value posted back as `gateway`. */
  id: string
  /** `bnpl` is an instalment product — the picker says so, because it changes what the buyer is agreeing to. */
  kind: 'bnpl' | 'psp'
  label: string
  labelEn: string
  /** In the site's own minor units, or `null` when the provider sets no bound. */
  maxAmount: null | number
  minAmount: null | number
  /** Shown as a badge: a store taking test payments must not look like one taking money. */
  mode: 'live' | 'sandbox'
  requiresMobile: boolean
}


/**
 * What a payment provider is told about an order — and nothing more.
 *
 * Deliberately a *projection*, not the `Order` document. An adapter is about to send this
 * to a third party over HTTPS, and the order row carries a site relationship, stock figures,
 * timestamps and whatever a future field adds. Naming the fields means a new column on
 * `orders` cannot silently start leaving the server in a PSP's request body.
 *
 * Shared by both halves of `src/endpoints/checkout.ts` and by `POST /api/payments/cancel`,
 * because all three hand an order to the same adapters and a divergence between them would
 * be a divergence in what the PSP is told.
 */
export const toCheckoutOrder = ({
  locale,
  order,
  site,
}: {
  locale: string
  order: Order
  site: Site
}): CheckoutOrder => ({
  buyer: {
    email: order.buyer?.email ?? undefined,
    name: order.buyer?.name ?? '',
    phone: order.buyer?.phone ?? '',
  },
  currency: order.currency,
  id: String(order.id),
  locale,
  productTitle: order.productTitle ?? '',
  quantity: Number(order.quantity ?? 1),
  reference: String(order.reference ?? order.id),
  site,
  total: Number(order.total ?? 0),
})
