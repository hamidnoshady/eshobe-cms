import type { PaymentProvider } from './types'

/**
 * کارت به کارت — card to card, the way a large share of small Iranian stores take
 * payment: the site shows a card number, the buyer transfers, a human checks the
 * account and marks the order paid.
 *
 * It is in the code because it is not a joke or a placeholder: it needs no gateway
 * contract, no credentials and no callback URL, it settles in the store owner's own
 * account, and `settleStock` runs from the admin's status change exactly as it does
 * from a gateway callback. The same order lifecycle, no third party.
 *
 * Nothing here can confirm a payment — there is nothing to ask. `confirm` is absent
 * on purpose: a buyer's "I sent the money" is not a server-side verification, and an
 * adapter that accepted one would mark orders paid from a URL bar.
 */
export const bankProvider: PaymentProvider = {
  initiate: async () => ({
    // No redirect: the checkout flow stays on the store and shows the instructions.
    redirectUrl: null,
  }),
  label: 'کارت به کارت',
  name: 'bank',
}
