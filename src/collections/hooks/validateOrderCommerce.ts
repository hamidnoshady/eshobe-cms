import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

const numberOf = (value: unknown): null | number =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Multi-line order normalization (issue #166), backward-compatible by
 * construction: `items` is the real order, and the historic single-product
 * fields (`product`/`quantity`/`unitPrice`) mirror the first line so the
 * checkout, theme API, receipts and older integrations keep reading the same
 * shape they always have. A create that only carries the legacy fields gets
 * its one line synthesized here; a legacy row from before this schema simply
 * has no `items`, and `settleStock` keeps its original path for it.
 *
 * The exact money identity — subtotal − discount + shipping + tax + fees ≡
 * total, in integer minor units — is enforced whenever a write carries
 * lines and totals. "Close" is how a flattened Woo order used to lose a
 * shipping line; reconciliation downstream assumes this hook refused it.
 */
export const validateOrderCommerce: CollectionBeforeValidateHook = async ({
  collection,
  data,
  operation,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>
  const siteId = siteIdOfWrite(row, stored)
  const errors: { message: string; path: string }[] = []

  let items = Array.isArray(row.items) ? (row.items as Record<string, unknown>[]) : null
  let synthesizedLegacy = false

  // A legacy single-product create: synthesize its one line.
  if (operation === 'create' && (!items || items.length === 0)) {
    const product = row.product
    const quantity = numberOf(row.quantity) ?? 1
    const unitPrice = numberOf(row.unitPrice)

    if (product && unitPrice !== null) {
      const subtotal = unitPrice * quantity
      items = [
        {
          product,
          ...(typeof row.productTitle === 'string' && row.productTitle
            ? { productTitle: row.productTitle }
            : {}),
          quantity,
          subtotal,
          taxTotal: 0,
          total: subtotal,
          unitPrice,
        },
      ]
      row.items = items
      synthesizedLegacy = true
      if (numberOf(row.subtotal) === null) row.subtotal = subtotal
      if (numberOf(row.discountTotal) === null) row.discountTotal = 0
      if (numberOf(row.shippingTotal) === null) row.shippingTotal = 0
      if (numberOf(row.taxTotal) === null) row.taxTotal = 0
    }
  }

  if (items && items.length > 0) {
    items.forEach((item, index) => {
      const quantity = numberOf(item.quantity)
      const unitPrice = numberOf(item.unitPrice)

      if (!idOf(item.product)) {
        errors.push({ message: 'هر سطر سفارش محصول می‌خواهد.', path: `items.${index}.product` })
      }
      if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
        errors.push({ message: 'تعداد سطر سفارش باید عدد صحیح مثبت باشد.', path: `items.${index}.quantity` })
      }
      if (unitPrice === null || !Number.isInteger(unitPrice) || unitPrice < 0) {
        errors.push({
          message: 'قیمت واحد سطر باید عدد صحیح غیرمنفی در واحد خرد باشد.',
          path: `items.${index}.unitPrice`,
        })
      }

      if (quantity !== null && unitPrice !== null && numberOf(item.subtotal) === null) {
        item.subtotal = quantity * unitPrice
      }
      if (numberOf(item.total) === null && numberOf(item.subtotal) !== null) {
        item.total = item.subtotal
      }
      if (numberOf(item.taxTotal) === null) item.taxTotal = 0
    })

    if (!errors.length) {
      const first = items[0]!
      row.product = first.product
      row.quantity = first.quantity
      row.unitPrice = first.unitPrice

      const subtotal = items.reduce((sum, item) => sum + (numberOf(item.subtotal) ?? 0), 0)
      const lineTotals = items.reduce((sum, item) => sum + (numberOf(item.total) ?? 0), 0)

      if (numberOf(row.subtotal) === null) row.subtotal = numberOf(stored.subtotal) ?? subtotal
      if (numberOf(row.discountTotal) === null) {
        row.discountTotal = numberOf(stored.discountTotal) ?? Math.max(0, subtotal - lineTotals)
      }
      if (numberOf(row.shippingTotal) === null) {
        const shippingLines = Array.isArray(row.shippingLines)
          ? (row.shippingLines as Record<string, unknown>[])
          : Array.isArray(stored.shippingLines)
            ? (stored.shippingLines as Record<string, unknown>[])
            : []
        row.shippingTotal =
          numberOf(stored.shippingTotal) ??
          shippingLines.reduce((sum, line) => sum + (numberOf(line.total) ?? 0), 0)
      }
      if (numberOf(row.taxTotal) === null) {
        row.taxTotal =
          numberOf(stored.taxTotal) ??
          items.reduce((sum, item) => sum + (numberOf(item.taxTotal) ?? 0), 0)
      }

      const fees = Array.isArray(row.fees)
        ? (row.fees as Record<string, unknown>[])
        : Array.isArray(stored.fees)
          ? (stored.fees as Record<string, unknown>[])
          : []
      const feeTotal = fees.reduce((sum, fee) => sum + (numberOf(fee.total) ?? 0), 0)
      const computed =
        (numberOf(row.subtotal) ?? 0) -
        (numberOf(row.discountTotal) ?? 0) +
        (numberOf(row.shippingTotal) ?? 0) +
        (numberOf(row.taxTotal) ?? 0) +
        feeTotal

      if (numberOf(row.total) === null && numberOf(stored.total) === null) row.total = computed

      const declared = numberOf(row.total) ?? numberOf(stored.total)
      if (declared !== null && declared !== computed) {
        errors.push({
          message: `جمع سفارش با سطرها نمی‌خواند: سطرها و هزینه‌ها ${computed} و مبلغ کل ${declared} واحد خرد است.`,
          path: 'total',
        })
      }
    }
  }

  if (errors.length) failField(collection, req, errors)
  if (!siteId) return data

  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      const productId = idOf(item.product)
      if (!productId) continue
      const product = await findOnSite(req, 'products', productId, siteId, { title: true })

      if (!product) {
        // A synthesized legacy line defers to `snapshotOrder`, which has
        // always reported this refusal on `product` — the historic field
        // name existing API consumers already handle.
        if (synthesizedLegacy) continue
        failField(collection, req, [
          { message: 'محصول سطر سفارش باید از همین فروشگاه باشد.', path: `items.${index}.product` },
        ])
      } else if (typeof item.productTitle !== 'string' || !item.productTitle) {
        const title = (product as Record<string, unknown>).title
        item.productTitle = typeof title === 'string' ? title : ''
      }
    }
  }

  const customerId = idOf(row.customer)
  if (customerId) {
    const customer = await findOnSite(req, 'customers', customerId, siteId, { id: true })
    if (!customer) {
      failField(collection, req, [
        { message: 'مشتری سفارش باید از همین فروشگاه باشد.', path: 'customer' },
      ])
    }
  }

  const coupons = Array.isArray(row.coupons) ? (row.coupons as Record<string, unknown>[]) : null
  if (coupons) {
    for (let index = 0; index < coupons.length; index += 1) {
      const couponId = idOf(coupons[index]!.coupon)
      if (!couponId) continue
      const coupon = await findOnSite(req, 'coupons', couponId, siteId, { code: true })
      if (!coupon) {
        failField(collection, req, [
          { message: 'کوپن سفارش باید از همین فروشگاه باشد.', path: `coupons.${index}.coupon` },
        ])
      } else if (typeof coupons[index]!.code !== 'string' || !coupons[index]!.code) {
        const code = (coupon as Record<string, unknown>).code
        coupons[index]!.code = typeof code === 'string' ? code : ''
      }
    }
  }

  return data
}
