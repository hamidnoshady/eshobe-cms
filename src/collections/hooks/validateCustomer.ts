import type { CollectionBeforeValidateHook } from 'payload'

import { failField, siteIdOfWrite } from './contentSameSite'

/**
 * One storefront customer per (site, email). Importing a Woo customer twice
 * must update the same profile — the migration ledger is the primary
 * idempotency key, and this hook is the second belt for rows created by
 * staff or adopted from an earlier partial import. A customer is never a
 * `users` row: no password credential is copied from WordPress, so accounts
 * are claimed by invitation/reset (`claimStatus`), not transplanted.
 */
export const validateCustomer: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>

  if (typeof row.email === 'string') row.email = row.email.trim().toLowerCase()
  if (typeof row.phone === 'string') row.phone = row.phone.trim()
  if (typeof row.username === 'string') row.username = row.username.trim()

  const email =
    typeof row.email === 'string' && row.email ? row.email : (stored.email as string | undefined)
  const phone =
    typeof row.phone === 'string' && row.phone ? row.phone : (stored.phone as string | undefined)

  if (!email && !phone) {
    failField(collection, req, [
      { message: 'مشتری دست‌کم ایمیل یا تلفن می‌خواهد؛ بدون هیچ‌کدام قابل شناسایی یا مطالبه حساب نیست.', path: 'email' },
    ])
  }

  const addresses = Array.isArray(row.addresses)
    ? (row.addresses as Record<string, unknown>[])
    : null

  if (addresses) {
    const defaultBilling = addresses.filter((address) => address.isDefaultBilling === true).length
    const defaultShipping = addresses.filter((address) => address.isDefaultShipping === true).length

    if (defaultBilling > 1 || defaultShipping > 1) {
      failField(collection, req, [
        {
          message: 'برای صورت‌حساب و ارسال، هر مشتری حداکثر یک نشانی پیش‌فرض دارد.',
          path: 'addresses',
        },
      ])
    }
  }

  const siteId = siteIdOfWrite(row, stored)

  if (siteId && email) {
    const { docs } = await req.payload.find({
      collection: 'customers',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      req,
      select: { email: true },
      where: { and: [{ site: { equals: siteId } }, { email: { equals: email } }] },
    })
    const clash = docs.find((doc) => String(doc.id) !== String(stored.id ?? ''))

    if (clash) {
      failField(collection, req, [
        { message: 'مشتری دیگری با همین ایمیل در این سایت ثبت شده است.', path: 'email' },
      ])
    }
  }

  return data
}
