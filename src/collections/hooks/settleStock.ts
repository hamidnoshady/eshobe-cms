import type { CollectionAfterChangeHook, PayloadRequest } from 'payload'

import type { Order, Product } from '@/payload-types'

const idOf = (value: unknown): null | string => {
  if (!value) return null

  return typeof value === 'object' ? String((value as { id: unknown }).id) : String(value)
}

const isPaid = (order: null | Order | undefined): boolean => order?.status === 'paid'

/**
 * Moves stock when an order crosses the paid line — and only there.
 *
 * ## Why `paid`, not `create`
 *
 * Reserving stock at order time is the other option, and it is worse for a store
 * this size: an abandoned checkout then needs a TTL job to release it, and a shop
 * whose payment is confirmed by a human (کارت به کارت) would hold the last unit
 * hostage for hours. The cost of the choice is stated rather than hidden: between
 * "ordered" and "paid" two buyers can both be told the item is available, and the
 * second is refunded rather than silently oversold.
 *
 * Refunds and cancellations put the units back, so the transition is computed from
 * `previousDoc` — never from the incoming data, which says nothing about where the
 * order was before.
 *
 * ## Why this write is not access-controlled
 *
 * The hook runs inside a request whose user is often *nobody*: the gateway's
 * callback. Access control on the product write would then fail a completed payment,
 * which is the worst possible outcome to protect against. What makes the write safe
 * is the `site` predicate on the product read — the tenant comes from the order, and
 * a product belonging to another site is refused by name — which is the same rule
 * `CLAUDE.md` states for every write.
 */
export const settleStock: CollectionAfterChangeHook<Order> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update') return doc

  const before = isPaid(previousDoc)
  const after = isPaid(doc)

  if (before === after) return doc

  const direction = after ? -1 : 1

  const productId = idOf(doc.product)
  const siteId = idOf(doc.site)

  if (!productId || !siteId) {
    req.payload.logger.warn({ msg: `orders/${doc.id}: no product or site, stock left alone` })

    return doc
  }

  const quantity = Math.max(1, Math.trunc(Number(doc.quantity ?? 1)))

  const product = await findOwnProduct(req, productId, siteId)

  if (!product) {
    req.payload.logger.warn({
      msg: `orders/${doc.id}: product ${productId} is not on this site, stock left alone`,
    })

    return doc
  }

  // Untracked stock is a number nobody counts, so nothing moves.
  if (!product.trackInventory || typeof product.inventory !== 'number') return doc

  const next = product.inventory + direction * quantity

  if (next < 0) {
    // The money has been taken: the order stands and the count bottoms out. The
    // owner learns about it from this line, not from an angry customer.
    req.payload.logger.error({
      msg: `oversold: products/${productId} had ${product.inventory}, order ${doc.id} needs ${quantity}`,
    })
  }

  await req.payload.update({
    id: productId,
    collection: 'products',
    data: { inventory: Math.max(0, next) },
    depth: 0,
    overrideAccess: true,
    req,
  })

  return doc
}

const findOwnProduct = async (
  req: PayloadRequest,
  productId: string,
  siteId: string,
): Promise<Product | undefined> => {
  const { docs } = await req.payload.find({
    collection: 'products',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    select: { inventory: true, site: true, trackInventory: true },
    where: {
      and: [{ id: { equals: productId } }, { site: { equals: siteId } }],
    },
  })

  return docs[0] as Product | undefined
}
