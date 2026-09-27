import type { CollectionAfterChangeHook } from 'payload'

import type { Order } from '@/payload-types'
import { emitPlatformEvent } from '@/platform/webhooks'

/**
 * When a paid store order moves to `refunded` or `cancelled`, record the reversal
 * on the platform feed so cafe-restaurant-pos can void the imported sale.
 */
export const emitOrderReversal: CollectionAfterChangeHook<Order> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update') return doc
  if (previousDoc?.status !== 'paid') return doc
  if (doc.status !== 'refunded' && doc.status !== 'cancelled') return doc

  const event = doc.status === 'refunded' ? 'order.refunded' : 'order.cancelled'

  await emitPlatformEvent(req, {
    data: {
      currency: doc.currency ?? null,
      orderId: String(doc.id),
      reference: doc.reference ?? null,
      status: doc.status,
      total: doc.total ?? null,
    },
    event,
    message:
      doc.status === 'refunded'
        ? `سفارش ${doc.reference ?? doc.id} بازپرداخت شد.`
        : `سفارش ${doc.reference ?? doc.id} لغو شد.`,
    site: doc.site,
    targetCollection: 'orders',
    targetId: String(doc.id),
  })

  return doc
}
