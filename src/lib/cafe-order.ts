/**
 * Shared, deterministic rules for a café order — the parts both the endpoint and the
 * tests must agree on.
 *
 * Everything here is *pure*: no database, no request, no clock it was not handed. The
 * checkout endpoint re-reads products, prices and modifiers from the database and then
 * routes those facts through these functions, so the rules can be exercised without a
 * Postgres connection and a reviewer can read the policy in one place.
 *
 * ## Why a service mode is not just another field on `orders`
 *
 * `orders.status` is the **payment** lifecycle (`pending/paid/cancelled/refunded`) and
 * stays that way. Whether the kitchen has accepted the order is a second, independent
 * lifecycle owned by the POS (`fulfillment`), and whether the guest is sitting at a
 * table is a third fact (`serviceMode` + the opaque table token). Collapsing them into
 * one enum is how "paid" ends up meaning "cooked", and how cancelling an unpaid order
 * would erase the kitchen's copy of it.
 */

/** The only service modes a café order may declare. Delivery/reservation are absent by design. */
export const SERVICE_MODES = ['dine_in', 'takeaway'] as const

export type ServiceMode = (typeof SERVICE_MODES)[number]

export const isServiceMode = (value: unknown): value is ServiceMode =>
  typeof value === 'string' && (SERVICE_MODES as readonly string[]).includes(value)

/**
 * How the guest intends to pay.
 *
 * `online` runs the existing gateway flow. `counter` creates an ordinary unpaid order
 * and calls **no** provider — a salesperson takes the money at the till, in Biza.
 *
 * `online` is also the default for a café order that names no choice, because an
 * `order.submitted` that silently promised nothing would leave the POS with an order it
 * cannot invoice and the guest with no way to pay it.
 */
export const PAYMENT_CHOICES = ['online', 'counter'] as const

export type PaymentChoice = (typeof PAYMENT_CHOICES)[number]

export const isPaymentChoice = (value: unknown): value is PaymentChoice =>
  typeof value === 'string' && (PAYMENT_CHOICES as readonly string[]).includes(value)

/**
 * The payment provider stored on an order that was submitted to the counter.
 *
 * A *method*, never a gateway: `resolvePaymentProvider('counter')` has no adapter that
 * can initiate or confirm anything, so a stray callback naming one can never mark the
 * order paid (`src/payments/index.ts`). The order is settled in the POS, and the CMS
 * learns about it through the POS's own status update (or not at all).
 */
export const COUNTER_PROVIDER = 'counter'

/**
 * An opaque, Biza-minted table reference.
 *
 * The CMS never parses this into a table id and never looks one up: the token is
 * carried to the POS verbatim on `order.submitted`, and Biza resolves it inside its own
 * tenant/site/branch scope. That is the whole point — a raw table id in a request body
 * is a table id a guest can edit, and there is no per-table secret in the CMS to check
 * it against.
 *
 * The shape check is a *transport* check (it must survive a URL, a JSON body and a
 * database column), not an authorization one. Being generous about the alphabet and
 * strict about the length keeps a future token format from needing a CMS deploy.
 */
export const MAX_TABLE_TOKEN_LENGTH = 512

export const TABLE_TOKEN_PATTERN = /^[A-Za-z0-9._~:/+-]{8,512}$/

export const isTableToken = (value: unknown): value is string =>
  typeof value === 'string' && TABLE_TOKEN_PATTERN.test(value)

/**
 * The idempotency key a storefront may attach to a checkout attempt.
 *
 * A lost response is the normal case on a café's wifi: the browser gives up, the guest
 * hits «ثبت سفارش» again, and without this the kitchen gets two identical tickets. The
 * key is chosen by the client (one per cart composition), stored on the order, and a
 * retry that matches it returns the **same** order instead of creating a second one.
 *
 * Deliberately opaque and client-named: a value the server generates per response
 * cannot help a retry the server never saw the first half of.
 */
export const MAX_CHECKOUT_REQUEST_ID_LENGTH = 128

export const isCheckoutRequestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 8 &&
  value.length <= MAX_CHECKOUT_REQUEST_ID_LENGTH &&
  /^[A-Za-z0-9._:-]+$/.test(value)

/**
 * A stable fingerprint of *what is in the basket*, independent of how the client
 * ordered it or how many decimals a JSON number felt like printing.
 *
 * Two requests with the same request id but different baskets are **not** the same
 * order — that is a client reusing a key after the guest edited the cart, and returning
 * the old order would hand them food they changed their mind about. So the key is the
 * pair, and the pair decides:
 *
 *  - same id, same fingerprint → the same order (return it, emit nothing new)
 *  - same id, different fingerprint → refuse: the client's key is stale
 *
 * Lines are sorted by (product, variation, modifiers) so a client that rebuilds its
 * array from a `Set` does not produce a different fingerprint for the same cart.
 */
const digestSource = (lines: readonly CartFingerprintLine[]): string =>
  JSON.stringify(
    [...lines]
      .map((line) => ({
        m: [...(line.modifiers ?? [])]
          .map((choice) => ({ g: choice.groupId, o: [...choice.optionIds].sort() }))
          .sort((a, b) => (a.g === b.g ? 0 : a.g < b.g ? -1 : 1)),
        p: line.productId,
        q: line.quantity,
        v: line.variation ?? '',
      }))
      .sort((a, b) => {
        const left = JSON.stringify(a)
        const right = JSON.stringify(b)
        return left === right ? 0 : left < right ? -1 : 1
      }),
  )

export type CartFingerprintLine = {
  modifiers?: readonly { groupId: string; optionIds: readonly string[] }[]
  productId: string
  quantity: number
  variation?: null | string
}

/**
 * FNV-1a over the canonical basket JSON, 128 bits' worth, base36.
 *
 * A cryptographic hash is not needed and `node:crypto` is not available in the client
 * bundle this module is also imported from (`CafeMenuClient`). What the value has to do
 * is make two *different* baskets collide with negligible probability and be stable
 * across processes — both of which four independent 32-bit lanes give us. It is not a
 * security boundary: the request id is checked against the same site's orders, and an
 * attacker who can guess their own order id gains nothing they were not already sent.
 */
export const cartFingerprint = (lines: readonly CartFingerprintLine[]): string => {
  const source = digestSource(lines)
  let hash = ''
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b1, 0x85ebca6b]

  for (const seed of seeds) {
    let value = seed >>> 0

    for (let index = 0; index < source.length; index += 1) {
      value ^= source.charCodeAt(index)
      value = Math.imul(value, 0x01000193) >>> 0
    }

    hash += value.toString(36).padStart(7, '0')
  }

  return hash
}

/**
 * The fulfillment lifecycle the customer receipt displays.
 *
 * The CMS does not *drive* this — the POS does, through its site-key status update —
 * but it has to be a closed list here or the receipt would render whatever string
 * arrived. Wider than the minimum on purpose: Biza's own staff workflow has a
 * `preparing/ready/served` tail and an explicit `rejected`, and a value the CMS drops
 * on the floor is a guest looking at «در انتظار تأیید» after the kitchen already
 * refused the order.
 */
export const FULFILLMENT_STATES = [
  'awaiting_approval',
  'accepted',
  'preparing',
  'ready',
  'served',
  'rejected',
] as const

export type FulfillmentState = (typeof FULFILLMENT_STATES)[number]

export const isFulfillmentState = (value: unknown): value is FulfillmentState =>
  typeof value === 'string' && (FULFILLMENT_STATES as readonly string[]).includes(value)

export const FULFILLMENT_LABELS_FA: Record<FulfillmentState, string> = {
  accepted: 'پذیرفته شد',
  awaiting_approval: 'در انتظار تأیید کافه',
  preparing: 'در حال آماده‌سازی',
  ready: 'آماده است',
  rejected: 'رد شد',
  served: 'تحویل شد',
}

/**
 * A checkout request, reduced to the facts the endpoint needs — and to *only* those.
 *
 * `company` is the honeypot and is read by the caller, not here. Prices, totals,
 * discounts and taxes are absent by construction: there is nowhere in this type for a
 * client-supplied amount to live, which is the cheapest possible way to make "ignore
 * client prices" true rather than remembered.
 */
export type CafeCheckoutInput = {
  checkoutRequestId?: null | string
  items: { modifiers?: unknown; productId: string; quantity: number; variation?: string }[]
  note?: string
  paymentChoice: null | PaymentChoice
  serviceMode: null | ServiceMode
  tableToken?: null | string
}

export type CafeCheckoutRefusal =
  | 'checkout_request_id_invalid'
  | 'dine_in_requires_table_token'
  | 'invalid_service_mode'
  | 'takeaway_forbids_table_token'
  | 'table_token_invalid'
  | 'unsupported_service_mode'

/**
 * The service-mode rules, in one place, in the order a buyer would hit them.
 *
 * `serviceMode` absent means "this is the legacy storefront": no table, no café
 * semantics, and the checkout behaves exactly as it did before this module existed
 * (issue #197 — existing one-product checkout stays backward compatible).
 */
export const refuseServiceMode = (
  input: Pick<CafeCheckoutInput, 'serviceMode' | 'tableToken'>,
): CafeCheckoutRefusal | null => {
  const { serviceMode, tableToken } = input

  if (serviceMode === null || serviceMode === undefined) {
    // A table token without a service mode is a client that half-updated; refusing is
    // louder than silently dropping the table, which would send a dine-in order to the
    // counter with no table on it.
    return tableToken ? 'invalid_service_mode' : null
  }

  if (!isServiceMode(serviceMode)) return 'unsupported_service_mode'

  if (serviceMode === 'dine_in') {
    if (!tableToken) return 'dine_in_requires_table_token'
    return isTableToken(tableToken) ? null : 'table_token_invalid'
  }

  // Takeaway: a token here means the client tried to attach a table to a bag, which is
  // either a stale form or a probe. Either way the order must not carry both.
  return tableToken ? 'takeaway_forbids_table_token' : null
}

/**
 * Does this cart need the café semantics at all?
 *
 * Any explicit `serviceMode`, `tableToken`, `paymentChoice` or `checkoutRequestId` says
 * so. An ordinary one-product storefront posts none of them and keeps the legacy
 * duplicate guard, the legacy coupon handling and the legacy first-line mirror.
 */
export const isCafeCheckout = (data: Record<string, unknown>): boolean =>
  data.serviceMode !== undefined ||
  data.tableToken !== undefined ||
  data.paymentChoice !== undefined ||
  data.checkoutRequestId !== undefined

/**
 * The `order.submitted` payload, in the one place both producers read.
 *
 * The event has exactly two routes out of this CMS — the signed webhook fan-out
 * (`emitOrderSubmitted`) and the poll feed (`platform/events.ts`) — and a receiver that
 * consumes both must not be able to tell them apart. Two hand-maintained field lists is
 * how that guarantee rots: one side gains a field during a review, the other does not,
 * and Biza's intake starts accepting-or-rejecting depending on which path delivered the
 * order. So both call this function, and `tests/int/cafe-order-rules.int.spec.ts` pins
 * its keys against `tests/fixtures/store-order-contract/order-submitted-platform-event.json`.
 *
 * Takes `unknown` for the order rather than the generated `Order` type because the poll
 * feed selects a projection (`cafe`, `payment`, `total`, …) instead of a full document;
 * every value is therefore normalised here rather than trusted.
 */
export const orderSubmittedData = (order: Record<string, unknown>): Record<string, unknown> => {
  const cafe = (order.cafe ?? {}) as Record<string, unknown>
  const payment = (order.payment ?? {}) as Record<string, unknown>

  return {
    currency: order.currency ?? null,
    // Bump on a breaking change, never on an additive one: a receiver keys its parser
    // on this, and a version that moves for a new field forces every consumer to
    // re-deploy before it can accept it.
    eventVersion: 1,
    fulfillment: isFulfillmentState(cafe.fulfillment) ? cafe.fulfillment : 'awaiting_approval',
    orderId: String(order.id),
    paymentProvider: payment.provider ?? null,
    paymentStatus: order.status ?? null,
    reference: order.reference ?? null,
    serviceMode: cafe.serviceMode ?? null,
    // Verbatim. Resolving it is Biza's job, on Biza's data.
    tableToken: cafe.tableToken ?? null,
    total: order.total ?? null,
  }
}
