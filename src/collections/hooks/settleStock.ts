import type { CollectionAfterChangeHook, PayloadRequest } from 'payload'

import type { Coupon, Order, Product } from '@/payload-types'
import { isMigrationWrite } from '@/lib/migration-context'

const idOf = (value: unknown): null | string => {
  if (!value) return null

  return typeof value === 'object' ? String((value as { id: unknown }).id) : String(value)
}

const isPaid = (order: null | Order | undefined): boolean => order?.status === 'paid'

type StockLine = { externalInventory: boolean; productId: string; quantity: number; variationKey: null | string }

/**
 * Moves stock (and coupon usage) when an order crosses the paid line — and
 * only there.
 *
 * ## Why `paid`, not `create`
 *
 * Reserving stock at order time is the other option, and it is worse for a
 * store this size: an abandoned checkout then needs a TTL job to release it,
 * and a shop whose payment is confirmed by a human (کارت به کارت) would hold
 * the last unit hostage for hours. The cost of the choice is stated rather
 * than hidden: between "ordered" and "paid" two buyers can both be told the
 * item is available, and the second is refunded rather than silently
 * oversold.
 *
 * Refunds and cancellations put the units back, so the transition is
 * computed from `previousDoc` — never from the incoming data, which says
 * nothing about where the order was before.
 *
 * ## Lines
 *
 * An order settles *every* line it carries: `items` first (the multi-line
 * shape), or the historic single `product`/`quantity` pair for a row written
 * before lines existed. A line naming a variation settles that variation's
 * own count when the variation tracks one, and otherwise the product's —
 * the same fallback the checkout used when it priced the line.
 *
 * ## Why this write is not access-controlled
 *
 * The hook runs inside a request whose user is often *nobody*: the gateway's
 * callback. Access control on the product write would then fail a completed
 * payment, which is the worst possible outcome to protect against. What
 * makes the write safe is the `site` predicate on the product read — the
 * tenant comes from the order, and a product belonging to another site is
 * refused by name — which is the same rule `CLAUDE.md` states for every
 * write.
 *
 * A replayed historical order is bookkeeping, not a sale: under the audited
 * migration context (`src/lib/migration-context.ts`) nothing here moves, so
 * importing ten years of Woo orders cannot drain today's stock.
 */
export const settleStock: CollectionAfterChangeHook<Order> = async ({
  doc,
  operation,
  previousDoc,
  req,
}) => {
  if (operation !== 'update') return doc

  // A replayed historical order is bookkeeping, not a sale: stock stays put.
  if (isMigrationWrite(req, idOf(doc.site))) return doc

  const before = isPaid(previousDoc)
  const after = isPaid(doc)

  if (before === after) return doc

  const siteId = idOf(doc.site)

  if (!siteId) {
    req.payload.logger.warn({ msg: `orders/${doc.id}: no site, stock left alone` })

    return doc
  }

  /**
   * ESH-150 — a café order is a POS ticket, and its inventory is the POS's.
   *
   * Biza consumes recipe/ingredient stock for these orders and later pushes the
   * authoritative projection of each menu product back here. Decrementing the mirrored
   * `inventory` on top of that would count one latte twice, and would leave the CMS
   * disagreeing with the POS until the next sync — which for a busy Saturday is hours of
   * "we have 3 left" for items that sold out at noon.
   *
   * The flag is the order's own service mode, not a per-line guess: an ordinary
   * storefront order that happens to contain a Biza product still settles that product's
   * line unless the product itself is marked `externalInventory` (which it is, see
   * `validateOrderCommerce`), and a café order never touches a count at all. Coupon usage
   * — a CMS-owned counter — still moves, below.
   */
  const posOwned = Boolean(doc.cafe?.serviceMode)
  const direction = after ? -1 : 1
  const lines = posOwned ? [] : stockLinesOf(doc)

  // Group by product: two variations of one product settle in one write.
  const byProduct = new Map<string, StockLine[]>()
  for (const line of lines) {
    byProduct.set(line.productId, [...(byProduct.get(line.productId) ?? []), line])
  }

  for (const [productId, productLines] of byProduct) {
    const product = await findOwnProduct(req, productId, siteId)

    if (!product) {
      req.payload.logger.warn({
        msg: `orders/${doc.id}: product ${productId} is not on this site, stock left alone`,
      })
      continue
    }

    // Both the current owner and the order-time snapshot protect a POS stock
    // projection. The latter also covers a later ownership change or a refund.
    if (product.externalInventory || product.menuSourceSystem === 'biza_miz') continue

    const variations = (product.variations ?? []).map((variation) => ({ ...variation }))
    let variationsChanged = false
    let productUnits = 0

    for (const line of productLines) {
      if (line.externalInventory) continue
      const variation = line.variationKey
        ? variations.find((candidate) => candidate.key === line.variationKey)
        : undefined

      if (variation?.trackInventory && typeof variation.inventory === 'number') {
        const next = variation.inventory + direction * line.quantity

        if (next < 0) {
          req.payload.logger.error({
            msg: `oversold: products/${productId} variation ${line.variationKey} had ${variation.inventory}, order ${doc.id} needs ${line.quantity}`,
          })
        }
        variation.inventory = Math.max(0, next)
        variationsChanged = true
      } else {
        productUnits += line.quantity
      }
    }

    const data: Record<string, unknown> = {}

    if (productUnits > 0 && product.trackInventory && typeof product.inventory === 'number') {
      const next = product.inventory + direction * productUnits

      if (next < 0) {
        // The money has been taken: the order stands and the count bottoms
        // out. The owner learns about it from this line, not from an angry
        // customer.
        req.payload.logger.error({
          msg: `oversold: products/${productId} had ${product.inventory}, order ${doc.id} needs ${productUnits}`,
        })
      }
      data.inventory = Math.max(0, next)
    }
    if (variationsChanged) data.variations = variations

    if (Object.keys(data).length > 0) {
      await req.payload.update({
        id: productId,
        collection: 'products',
        data: data as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
    }
  }

  await settleCouponUsage({ after, doc, req, siteId })

  return doc
}

const stockLinesOf = (doc: Order): StockLine[] => {
  const items = doc.items ?? []

  if (items.length > 0) {
    return items.flatMap((item) => {
      const productId = idOf(item.product)
      if (!productId) return []

      return [
        {
          externalInventory: item.externalInventory === true,
          productId,
          quantity: Math.max(1, Math.trunc(Number(item.quantity ?? 1))),
          variationKey: item.variationKey?.trim() ? item.variationKey.trim() : null,
        },
      ]
    })
  }

  const productId = idOf(doc.product)
  if (!productId) return []

  return [
    {
      externalInventory: false,
      productId,
      quantity: Math.max(1, Math.trunc(Number(doc.quantity ?? 1))),
      variationKey: null,
    },
  ]
}

/** A coupon is spent when its order is paid, and returned when that payment is reversed. */
const settleCouponUsage = async ({
  after,
  doc,
  req,
  siteId,
}: {
  after: boolean
  doc: Order
  req: PayloadRequest
  siteId: string
}): Promise<void> => {
  const delta = after ? 1 : -1

  for (const row of doc.coupons ?? []) {
    const couponId = idOf(row.coupon)
    if (!couponId) continue

    const { docs } = await req.payload.find({
      collection: 'coupons',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      select: { usageCount: true },
      where: {
        and: [{ id: { equals: couponId } }, { site: { equals: siteId } }],
      },
    })
    const coupon = docs[0] as Coupon | undefined

    if (!coupon) {
      req.payload.logger.warn({
        msg: `orders/${doc.id}: coupon ${couponId} is not on this site, usage left alone`,
      })
      continue
    }

    await req.payload.update({
      id: couponId,
      collection: 'coupons',
      data: { usageCount: Math.max(0, Number(coupon.usageCount ?? 0) + delta) },
      depth: 0,
      overrideAccess: true,
      req,
    })
  }
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
    select: { externalInventory: true, inventory: true, menuSourceSystem: true, site: true, trackInventory: true, variations: true },
    where: {
      and: [{ id: { equals: productId } }, { site: { equals: siteId } }],
    },
  })

  return docs[0] as Product | undefined
}
