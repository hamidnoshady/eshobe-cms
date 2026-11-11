import type { PaymentProvider } from './types'

/**
 * Pay at the counter — the guest orders from the table, walks up, and pays the till.
 *
 * ## Why this is a provider and not a boolean
 *
 * `orders.payment.provider` already answers "how is this order supposed to be paid",
 * it is a closed `select`, and every reader of an order — the receipt, the admin list,
 * the POS import, the platform report — already switches on it. A separate
 * `payAtCounter` flag beside a provider that had to be *something* would have produced
 * two fields that can disagree, and the disagreement would be an order that says
 * `zarinpal` and was paid in cash.
 *
 * ## What it deliberately cannot do
 *
 * `initiate` returns nothing to redirect to and **no** amount has been charged; the
 * checkout endpoint never calls a PSP for an order naming this provider. `confirm` is
 * absent for exactly the reason `bank` has none: there is nothing to ask a server
 * about, and an adapter that accepted a browser's "I already paid at the counter"
 * would be a `/api/checkout/callback?order=…` that marks orders paid from a URL bar.
 *
 * The money moves in Biza's POS, which is the authority for a café's takings. The CMS
 * order stays `pending` until a human (or the POS, through its site-key status update)
 * says otherwise — which is the same path a card-to-card transfer takes.
 */
export const counterProvider: PaymentProvider = {
  initiate: async () => ({
    // No redirect: the buyer is already in the room, and the confirmation page tells
    // them to pay at the counter.
    redirectUrl: null,
  }),
  label: 'پرداخت در محل (صندوق)',
  name: 'counter',
}
