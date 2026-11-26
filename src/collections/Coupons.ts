import type { CollectionConfig } from 'payload'

import { hiddenFromOperators } from '@/admin/visibility'
import { authenticated } from '../access/authenticated'
import { migrationSourceField } from './fields/migrationSource'
import { validateCoupon } from './hooks/validateCoupon'

/**
 * A discount code. `amount` is a percent (0–100) for `percent`, otherwise
 * integer minor units of the site's currency — the same money rule as every
 * price on the platform, so an imported Woo coupon is converted by the
 * job's explicit Woo money settings, never copied as a float.
 */
export const Coupons: CollectionConfig = {
  slug: 'coupons',
  access: {
    create: authenticated,
    delete: authenticated,
    read: authenticated,
    update: authenticated,
  },
  admin: {
    defaultColumns: ['code', 'discountType', 'amount', 'active', 'usageCount'],
    group: 'فروشگاه',
    hidden: hiddenFromOperators,
    useAsTitle: 'code',
  },
  labels: { plural: 'کوپن‌های تخفیف', singular: 'کوپن تخفیف' },
  fields: [
    { name: 'code', type: 'text', label: 'کد', index: true, required: true },
    { name: 'description', type: 'textarea', label: 'توضیح', localized: true },
    {
      name: 'discountType',
      type: 'select',
      label: 'گونه تخفیف',
      defaultValue: 'fixed-cart',
      options: [
        { label: 'درصدی', value: 'percent' },
        { label: 'مبلغ ثابت سبد', value: 'fixed-cart' },
        { label: 'مبلغ ثابت محصول', value: 'fixed-product' },
      ],
      required: true,
    },
    {
      name: 'amount',
      type: 'number',
      label: 'مقدار',
      admin: { description: 'در گونه درصدی ۰ تا ۱۰۰؛ وگرنه واحد خرد پول سایت.' },
      min: 0,
      required: true,
    },
    { name: 'minimumAmount', type: 'number', label: 'حداقل مبلغ سفارش (واحد خرد)', min: 0 },
    { name: 'maximumAmount', type: 'number', label: 'حداکثر مبلغ سفارش (واحد خرد)', min: 0 },
    { name: 'usageLimit', type: 'number', label: 'سقف دفعات استفاده', min: 0 },
    { name: 'usageLimitPerUser', type: 'number', label: 'سقف هر مشتری', min: 0 },
    { name: 'usageCount', type: 'number', label: 'دفعات استفاده‌شده', defaultValue: 0, min: 0 },
    { name: 'individualUse', type: 'checkbox', label: 'فقط همین کوپن', defaultValue: false },
    { name: 'freeShipping', type: 'checkbox', label: 'ارسال رایگان', defaultValue: false },
    {
      name: 'products',
      type: 'relationship',
      label: 'محصول‌های مشمول',
      hasMany: true,
      relationTo: 'products',
    },
    {
      name: 'excludedProducts',
      type: 'relationship',
      label: 'محصول‌های مستثنا',
      hasMany: true,
      relationTo: 'products',
    },
    { name: 'startsAt', type: 'date', label: 'شروع' },
    { name: 'expiresAt', type: 'date', label: 'انقضا' },
    { name: 'active', type: 'checkbox', label: 'فعال', defaultValue: true },
    migrationSourceField({ optional: true }),
  ],
  hooks: { beforeValidate: [validateCoupon] },
}
