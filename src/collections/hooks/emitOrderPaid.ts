import type { CollectionAfterChangeHook } from 'payload'

import type { Order } from '@/payload-types'
import { emitPlatformEvent } from '@/platform/webhooks'

/**
 * When a store order crosses into `paid`, record `order.paid` on the platform feed
 * and fan out to subscribed webhooks (e.g. cafe-restaurant-pos
 * `POST /api/cms/order-events`).
 */
export const emitOrderPaid: CollectionAfterChangeHook<Order> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update') return doc
  if (previousDoc?.status === 'paid' || doc.status !== 'paid') return doc

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
