import type { Endpoint, PayloadRequest } from 'payload'

import { addDataAndFileToRequest } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import {
  COUNTER_PROVIDER,
  FULFILLMENT_PREDECESSORS,
  isFulfillmentState,
  parseCafePaymentUpdate,
} from '@/lib/cafe-order'
import { isUuid } from '@/lib/ids'

const respond = (status: number, result: string) =>
  Response.json({ ok: status === 200, result }, { headers: { 'cache-control': 'no-store' }, status })

/**
 * A payment-axis refusal carries the documented `error` name as well as `result`.
 *
 * `result` is what the fulfillment branch returns and what the POS worker already
 * reads; `error` is the name [eshobe-cms#221] publishes for the two permanent
 * answers (`amount_mismatch`, `invalid_payment_update`). Both keys are sent so a
 * worker written against either contract converges instead of retrying a write
 * that will never be accepted.
 */
const refusePayment = (status: number, code: string) =>
  Response.json(
    { error: code, ok: false, result: code },
    { headers: { 'cache-control': 'no-store' }, status },
  )

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
  const paymentUpdate = body.kind === 'payment' ? parseCafePaymentUpdate(body) : null
  if (body.kind === 'payment' && !paymentUpdate) {
    return refusePayment(400, 'invalid_payment_update')
  }

  // Each update uses a single atomic predicate. The read below only classifies a
  // no-op, so concurrent deliveries cannot bypass the transition or payment guard.
  // Projection writes deliberately skip collection hooks: Biza owns the stock
  // and has already recorded the payment, so a status write here must not emit
  // `order.paid`/`order.refunded` back at it (eshobe-cms#221).
  if (body.kind === 'fulfillment') {
    const { fulfillment, tableLabel } = body
    /**
     * A rejection carries the café's own words. It is optional so an older POS —
     * or a `cancelled` written by hand — stays valid, but a reason that *is*
     * sent must belong to a rejection and be short enough to print.
     */
    const reason = typeof body.reason === 'string' ? body.reason.trim() : null
    if (
      Object.keys(body).some((field) => !['kind', 'fulfillment', 'tableLabel', 'reason'].includes(field)) ||
      !isFulfillmentState(fulfillment) ||
      fulfillment === 'awaiting_approval' ||
      (body.reason !== undefined &&
        (fulfillment !== 'rejected' || !reason || reason.length > 200)) ||
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
              cafe_fulfillment_reason = $6::text,
              cafe_table_label = COALESCE(cafe_table_label, $4)
        WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL
          AND ($4::text IS NULL OR (cafe_service_mode = 'dine_in'
            AND (cafe_table_token IS NULL OR strpos($4, cafe_table_token) = 0)))
          AND COALESCE(cafe_fulfillment::text, 'awaiting_approval') = ANY($5::text[])`,
      [orderId, key.siteId, fulfillment, label, FULFILLMENT_PREDECESSORS[fulfillment], reason],
    )
    // Fulfillment has its own timestamp. The generic order timestamp drives the
    // legacy paid/reversed poll feed and must not turn a kitchen change into a payment event.
    if (result.rowCount) return respond(200, 'applied')

    /**
     * A rejection that was already delivered — the first POS builds sent
     * `rejected` with no reason at all — may be re-sent with the text. Converge
     * the reason alone, without moving the transition timestamp, so replaying a
     * state event can backfill a receipt that had nothing to explain.
     */
    if (reason) {
      const patched = await db.query(
        `UPDATE orders SET cafe_fulfillment_reason = $3
          WHERE id = $1 AND site_id = $2 AND cafe_fulfillment::text = 'rejected'
            AND cafe_fulfillment_reason IS DISTINCT FROM $3`,
        [orderId, key.siteId, reason],
      )
      if (patched.rowCount) return respond(200, 'applied')
    }
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
  } else if (paymentUpdate) {
    if (paymentUpdate.state === 'paid') {
      // Only from `pending`. A `paid` that arrives after the order was refunded,
      // cancelled or settled is a stale delivery and is classified below.
      const result = await db.query(
        `UPDATE orders
            SET status = 'paid', payment_reference = $3,
                payment_paid_at = COALESCE($5::timestamptz, CURRENT_TIMESTAMP),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL
            AND status = 'pending' AND total = $4 AND currency::text = $6`,
        [
          orderId,
          key.siteId,
          paymentUpdate.reference,
          paymentUpdate.amount,
          paymentUpdate.occurredAt,
          paymentUpdate.currency,
        ],
      )
      if (result.rowCount) return respond(200, 'applied')
    } else {
      // `refunded` only from `paid`, and the refund fact is inserted in the same
      // statement that moves the status: a refused refund records nothing, and a
      // concurrent duplicate cannot record the same return twice.
      const result = await db.query(
        `WITH settled AS (
           UPDATE orders
              SET status = 'refunded', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL
              AND status = 'paid' AND total = $3 AND currency::text = $4
           RETURNING id
         )
         INSERT INTO orders_refunds (_order, _parent_id, id, source_id, amount, refunded_at, transaction_id)
         SELECT COALESCE((SELECT max(r._order) FROM orders_refunds r WHERE r._parent_id = settled.id), -1) + 1,
                settled.id, gen_random_uuid()::text, $5, $3,
                COALESCE($6::timestamptz, CURRENT_TIMESTAMP), $5
           FROM settled
         RETURNING _parent_id`,
        [
          orderId,
          key.siteId,
          paymentUpdate.amount,
          paymentUpdate.currency,
          paymentUpdate.reference,
          paymentUpdate.occurredAt,
        ],
      )
      if (result.rowCount) return respond(200, 'applied')
    }
  } else {
    return respond(400, 'invalid_kind')
  }

  const { rows: [stored] } = await db.query<{
    cafe_fulfillment: null | string
    currency: string
    payment_provider: string
    payment_reference: null | string
    status: string
    total: number | string
  }>(
    `SELECT cafe_fulfillment, currency, payment_provider, payment_reference, status, total
       FROM orders WHERE id = $1 AND site_id = $2 AND cafe_service_mode IS NOT NULL`,
    [orderId, key.siteId],
  )
  if (!stored) return respond(404, 'order_not_found')

  if (paymentUpdate) {
    // A wrong amount or currency is permanent and is answered before the lifecycle
    // classification, so the POS dead-letters it rather than retrying forever. It
    // is also what keeps a partial refund from marking the order refunded.
    if (
      Number(stored.total) !== paymentUpdate.amount ||
      String(stored.currency) !== paymentUpdate.currency
    ) return refusePayment(409, 'amount_mismatch')

    if (paymentUpdate.state === 'paid') {
      if (stored.status === 'paid' && stored.payment_reference === paymentUpdate.reference) {
        return respond(200, 'already_applied')
      }
      // Monotonic: a delivery that would move a refunded, cancelled or already
      // settled order back to paid is stale, not a conflict to keep retrying.
      if (
        stored.status === 'paid' ||
        stored.status === 'refunded' ||
        stored.status === 'cancelled'
      ) return respond(200, 'ignored_stale')

      return refusePayment(409, 'state_conflict')
    }

    if (stored.status !== 'refunded') return refusePayment(409, 'state_conflict')

    const { rowCount } = await db.query(
      `SELECT 1 FROM orders_refunds WHERE _parent_id = $1 AND source_id = $2 LIMIT 1`,
      [orderId, paymentUpdate.reference],
    )

    return rowCount ? respond(200, 'already_applied') : respond(200, 'ignored_stale')
  }

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
