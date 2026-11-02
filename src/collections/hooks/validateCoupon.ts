import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

/**
 * Coupon invariants: one code per site, an honest amount (a percent is
 * 0–100, a fixed amount is integer minor units of the site's currency), a
 * sane validity window, and product restrictions that can only name this
 * site's own products.
 */
export const validateCoupon: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>

  if (typeof row.code === 'string') row.code = row.code.trim().toUpperCase()

  const code = typeof row.code === 'string' && row.code ? row.code : (stored.code as string | undefined)
  const discountType = (row.discountType as string | undefined) ?? (stored.discountType as string | undefined)
  const amount = typeof row.amount === 'number' ? row.amount : (stored.amount as number | undefined)

  if (discountType === 'percent' && typeof amount === 'number' && (amount < 0 || amount > 100)) {
    failField(collection, req, [{ message: 'تخفیف درصدی باید بین ۰ تا ۱۰۰ باشد.', path: 'amount' }])
  }
  if (typeof amount === 'number' && amount < 0) {
    failField(collection, req, [{ message: 'مبلغ تخفیف منفی نمی‌شود.', path: 'amount' }])
  }

  const startsAt = row.startsAt ?? stored.startsAt
  const expiresAt = row.expiresAt ?? stored.expiresAt
  const startTime = typeof startsAt === 'string' ? Date.parse(startsAt) : Number.NaN
  const expiryTime = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN

  if (Number.isFinite(startTime) && Number.isFinite(expiryTime) && expiryTime < startTime) {
    failField(collection, req, [{ message: 'تاریخ انقضا پیش از تاریخ شروع است.', path: 'expiresAt' }])
  }

  const siteId = siteIdOfWrite(row, stored)

  if (siteId && code) {
    const { docs } = await req.payload.find({
      collection: 'coupons',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      req,
      select: { code: true },
      where: { and: [{ site: { equals: siteId } }, { code: { equals: code } }] },
    })
    const clash = docs.find((doc) => String(doc.id) !== String(stored.id ?? ''))

    if (clash) {
      failField(collection, req, [
        { message: 'کد تخفیف دیگری با همین کد در این سایت وجود دارد.', path: 'code' },
      ])
    }
  }

  for (const field of ['products', 'excludedProducts'] as const) {
    const values = Array.isArray(row[field]) ? (row[field] as unknown[]) : null
    if (!values || !siteId) continue

    for (const value of values) {
      const productId = idOf(value)
      if (!productId) continue
      const product = await findOnSite(req, 'products', productId, siteId, { id: true })
      if (!product) {
        failField(collection, req, [
          { message: 'محصول محدودکننده باید از همین فروشگاه باشد.', path: field },
        ])
      }
    }
  }

  return data
}
