import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

/**
 * Read-only operational cache of central Billing's decision for one site.
 *
 * Not a subscription. The version only moves forward; a delayed delivery of an
 * older version is ignored. While central Billing is unreachable, the last
 * accepted row is what the CMS enforces.
 */
export const CentralEntitlementProjections: CollectionConfig = {
  slug: 'central-entitlement-projections',
  access: {
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['site', 'version', 'serving', 'planCode', 'receivedAt'],
    description:
      'تصویر فقط‌خواندنیِ تصمیم پلتفرم اشوب برای این سایت. طرح و قیمت اینجا ویرایش نمی‌شوند.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'planCode',
  },
  labels: { plural: 'وضعیت تجاری', singular: 'وضعیت تجاری' },
  fields: [
    { name: 'version', type: 'number', required: true, min: 1, label: 'نسخه' },
    { name: 'serving', type: 'checkbox', required: true, defaultValue: false, label: 'در حال سرویس' },
    { name: 'planCode', type: 'text', label: 'کد طرح (اطلاعاتی)' },
    { name: 'subscriptionStatus', type: 'text', label: 'وضعیت اشتراک (اطلاعاتی)' },
    { name: 'features', type: 'json', label: 'امکانات تجاری' },
    { name: 'limits', type: 'json', label: 'سقف‌ها' },
    { name: 'billingCycleStart', type: 'date', label: 'شروع دوره' },
    { name: 'billingCycleEnd', type: 'date', label: 'پایان دوره' },
    { name: 'effectiveAt', type: 'date', label: 'زمان اعمال' },
    { name: 'receivedAt', type: 'date', label: 'زمان دریافت' },
    {
      name: 'source',
      type: 'select',
      required: true,
      defaultValue: 'push',
      label: 'منبع',
      options: [
        { label: 'ارسال از مرکز', value: 'push' },
        { label: 'دریافت از مرکز', value: 'pull' },
        { label: 'مهاجرت', value: 'migration' },
      ],
    },
    { name: 'checksum', type: 'text', label: 'چک‌سام' },
  ],
  timestamps: true,
}
