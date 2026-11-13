import type { CollectionAfterChangeHook } from 'payload'

import type { Order } from '@/payload-types'
import { orderSubmittedData } from '@/lib/cafe-order'
import { idOf } from '@/lib/ids'
import { isMigrationWrite } from '@/lib/migration-context'
import { emitPlatformEvent } from '@/platform/webhooks'

/**
 * Biza learns about a café order when the guest submits it — not when it is paid.
 *
 * ## Why submission is its own event
 *
 * A pay-at-counter order is never going to produce an `order.paid` from this CMS: the
 * money moves in the POS's own till. If the only outbound signal were `order.paid`, the
 * kitchen would never hear about half the orders until a member of staff typed them in
 * again, which is precisely the duplicate-entry problem this epic exists to remove.
 *
 * So `order.submitted` fires for **every** accepted café order, `pending` or paid, once,
 * at create. `order.paid` keeps its own meaning and its own timing (`emitOrderPaid`),
 * and both carry the same CMS order id — the POS is expected to converge them onto one
 * of its own orders, which is why the id and the reference are in the payload.
 *
 * ## Why "once" is enforced here and not only in the POS
 *
 * `operation === 'create'` is the mechanism: an order row can be updated a hundred times
 * (a status change, a note, the POS writing back a fulfillment state) and this hook runs
 * on none of them. The side effect of a retried *request* — as opposed to a retried
 * event — is prevented earlier, by the checkout request id: a retry returns the existing
 * order instead of creating a second one, so there is nothing for this hook to fire on.
 *
 * ## What travels
 *
 * Identity, not content. The event says *which* order on *which* site, its reference,
 * totals, service mode and whether it is already paid; Biza fetches the full document
 * through its site-scoped API key, which is the only credential that can read another
 * tenant's rows. Putting the line items in the webhook body would be a second, weaker
 * copy of an order that has exactly one authoritative one.
 */
export const emitOrderSubmitted: CollectionAfterChangeHook<Order> = async ({
  doc,
  operation,
  req,
}) => {
  if (operation !== 'create') return doc
  // A replayed historical import is bookkeeping, not a café ticket — the same rule
  // `emitOrderPaid` and `settleStock` already carry.
  if (isMigrationWrite(req, idOf(doc.site))) return doc

  // Only an order that declared a café service mode is a café order. An ordinary
  // one-product storefront checkout must keep emitting exactly the events it always
  // did, or every retail sale would appear in the café POS's approval queue.
  const serviceMode = doc.cafe?.serviceMode
  if (!serviceMode) return doc

  await emitPlatformEvent(req, {
    // The payload is built once, in `orderSubmittedData`, because the poll feed emits
    // the same event and the two shapes must not drift.
    data: orderSubmittedData(doc as unknown as Record<string, unknown>),
    event: 'order.submitted',
    message: `سفارش کافه ${doc.reference ?? doc.id} ثبت شد.`,
    site: doc.site,
    targetCollection: 'orders',
    targetId: String(doc.id),
  })

  return doc
}
