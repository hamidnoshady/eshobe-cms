import type { CollectionAfterChangeHook } from 'payload'

import type { Order } from '@/payload-types'
import { COUNTER_PROVIDER } from '@/lib/cafe-order'
import { idOf } from '@/lib/ids'
import { isMigrationWrite } from '@/lib/migration-context'
import { emitPlatformEvent } from '@/platform/webhooks'

/**
 * When a store order crosses into `paid`, record `order.paid` on the platform feed
 * and fan out to subscribed webhooks (e.g. cafe-restaurant-pos
 * `POST /api/cms/order-events`).
 *
 * ## The echo rule (ESH-150)
 *
 * For a café order, the POS is the system that *takes* the money at the counter and the
 * one that decides a counter order has been settled. When Biza writes that settlement
 * back onto the CMS order through its site key, `status` moves `pending → paid` here —
 * and this hook would announce "the guest paid online" to Biza, which is the system that
 * just told us. Left alone that is a feedback loop: one delivery per bounce, growing
 * with every poll, and a POS ledger that books a payment it never received through a
 * PSP.
 *
 * The rule is therefore **the CMS announces a payment only when the CMS took it**:
 *
 *  - `payment.provider === 'counter'` — the money was a counter transaction. Biza
 *    already knows; it recorded it. No event.
 *  - The update arrived with a site API key — the POS is the writer. Whatever it thinks
 *    it is telling us, telling it back is never news. No event.
 *
 * Everything else is unchanged: an online payment verified by `completeCheckout` (no
 * key, a PSP provider) emits exactly as it always has, and a human marking a
 * card-to-card transfer paid in the admin still emits, because that is a fact only the
 * CMS knows. A browser, a query string or a webhook body still cannot reach this hook's
 * condition: nothing here reads request data.
 */
export const emitOrderPaid: CollectionAfterChangeHook<Order> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update') return doc
  // History replayed by the importer is not a fresh payment: no event, no webhook.
  if (isMigrationWrite(req, idOf(doc.site))) return doc
  if (previousDoc?.status === 'paid' || doc.status !== 'paid') return doc
  // A counter settlement belongs to the POS's ledger, not to an online-payment event.
  if (doc.payment?.provider === COUNTER_PROVIDER) return doc
  // The POS is the writer: echoing its own update back is the loop this guard exists for.
  if (await arrivedFromSiteKey(req)) return doc

  await emitPlatformEvent(req, {
    data: {
      currency: doc.currency ?? null,
      orderId: String(doc.id),
      reference: doc.reference ?? null,
      total: doc.total ?? null,
    },
    event: 'order.paid',
    message: `سفارش ${doc.reference ?? doc.id} پرداخت شد.`,
    site: doc.site,
    targetCollection: 'orders',
    targetId: String(doc.id),
  })

  return doc
}

/**
 * Whether this update was written by a site API key.
 *
 * Imported lazily-by-call rather than at module load because `requestApiKey` reads the
 * request and touches `api-keys` telemetry; a hook that runs on every order write in the
 * platform (including the importer's thousands) must not pay for a credential lookup it
 * does not need. A request with no bearer token — a browser callback, an admin session,
 * `completeCheckout` itself — answers `false` without a query.
 */
const arrivedFromSiteKey = async (req: Parameters<CollectionAfterChangeHook<Order>>[0]['req']): Promise<boolean> => {
  const authorization = req.headers?.get?.('authorization')
  if (!authorization) return false

  const { requestApiKey } = await import('@/access/siteApiKey')
  const key = await requestApiKey(req)

  return key?.role === 'site'
}
