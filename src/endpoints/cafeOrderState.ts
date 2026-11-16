import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import { COUNTER_PROVIDER, FULFILLMENT_PREDECESSORS, isFulfillmentState } from '@/lib/cafe-order'
import { isUuid } from '@/lib/ids'

const respond = (status: number, result: string) =>
  Response.json({ ok: status === 200, result }, { headers: { 'cache-control': 'no-store' }, status })

/** Biza delivers committed order-state changes using the order's site credential. */
export const updateCafeOrderState = async (req: PayloadRequest): Promise<Response> => {
  const key = await requestApiKey(req)
  if (key?.role !== 'site' || !key.siteId) return respond(403, 'site_key_required')

  const orderId = req.routeParams?.orderId
  if (!isUuid(orderId)) return respond(400, 'invalid_order_id')

  try {
    await addDataAndFileToRequest(req)
  } catch {
    return respond(400, 'invalid_body')
  }
  if (!req.data || typeof req.data !== 'object' || Array.isArray(req.data)) {
    return respond(400, 'invalid_body')
  }

  const body: Record<string, unknown> = req.data
  const db = req.payload.db.pool

  // Each update uses a single atomic predicate. The read below only classifies a
  // no-op, so concurrent deliveries cannot bypass the transition or payment guard.
  // Projection writes deliberately skip collection hooks: Biza owns the stock
  // and has already recorded the counter payment.
  if (body.kind === 'fulfillment') {
    const { fulfillment, tableLabel } = body
    if (
      Object.keys(body).some((field) => !['kind', 'fulfillment', 'tableLabel'].includes(field)) ||
      !isFulfillmentState(fulfillment) ||
      fulfillment === 'awaiting_approval' ||
      (tableLabel !== undefined &&
        (typeof tableLabel !== 'string' ||
          tableLabel.trim().length === 0 ||
          tableLabel.length > 80 ||
          isUuid(tableLabel.trim())))
    ) return respond(400, 'invalid_fulfillment')

    const label = typeof tableLabel === 'string' ? tableLabel.trim() : null
    const result = await db.query(
      `UPDATE orders
          SET cafe_fulfillment = $3,
              cafe_fulfillment_at = CURRENT_TIMESTAMP,
              cafe_table_label = COALESCE(cafe_table_label, $4)
        WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL
          AND ($4::text IS NULL OR (cafe_service_mode = 'dine_in'
            AND (cafe_table_token IS NULL OR strpos($4, cafe_table_token) = 0)))
          AND COALESCE(cafe_fulfillment::text, 'awaiting_approval') = ANY($5::text[])`,
      [orderId, key.siteId, fulfillment, label, FULFILLMENT_PREDECESSORS[fulfillment]],
    )
    // Fulfillment has its own timestamp. The generic order timestamp drives the
    // legacy paid/reversed poll feed and must not turn a kitchen change into a payment event.
    if (result.rowCount) return respond(200, 'applied')
  } else if (body.kind === 'counter_payment') {
    const { accountingReference, amount } = body
    if (
      Object.keys(body).some((field) => !['kind', 'accountingReference', 'amount'].includes(field)) ||
      typeof accountingReference !== 'string' ||
      accountingReference.trim().length === 0 ||
      accountingReference.length > 128 ||
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 0
    ) return respond(400, 'invalid_payment')

    const result = await db.query(
      `UPDATE orders
          SET status = 'paid', payment_reference = $3,
              payment_paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL
          AND payment_provider = $5 AND status = 'pending' AND total = $4`,
      [orderId, key.siteId, accountingReference.trim(), amount, COUNTER_PROVIDER],
    )
    if (result.rowCount) return respond(200, 'applied')
  } else {
    return respond(400, 'invalid_kind')
  }

  const { rows: [stored] } = await db.query<{
    cafe_fulfillment: null | string
    payment_provider: string
    payment_reference: null | string
    status: string
    total: number | string
  }>(
    `SELECT cafe_fulfillment, payment_provider, payment_reference, status, total
       FROM orders WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL`,
    [orderId, key.siteId],
  )
  if (!stored) return respond(404, 'order_not_found')

  if (body.kind === 'fulfillment' && stored.cafe_fulfillment === body.fulfillment) {
    return respond(200, 'already_applied')
  }
  if (
    body.kind === 'counter_payment' &&
    stored.status === 'paid' &&
    stored.payment_provider === COUNTER_PROVIDER &&
    typeof body.accountingReference === 'string' &&
    stored.payment_reference === body.accountingReference.trim() &&
    Number(stored.total) === body.amount
  ) return respond(200, 'already_applied')

  return respond(409, 'state_conflict')
}

export const cafeOrderStateEndpoint: Endpoint = {
  handler: updateCafeOrderState,
  method: 'patch',
  path: '/site/cafe-orders/:orderId/state',
}
