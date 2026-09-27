import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

/**
 * One clock per site for time-weighted storage. `bytes` is the maintained
 * total; `accruedByteMs` is the unfinished hour. Completed hours leave as
 * `cms.storage_byte_hour` events. This is not a price.
 */
export const BillingStorageAccounts: CollectionConfig = {
  slug: 'billing-storage-accounts',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['site', 'bytes', 'accountedAt'],
    description: 'جمع بایت‌های ذخیره‌شده و انتگرال ساعت‌بایت. برای سهمیهٔ تقریبی اسکن فایل‌ها استفاده نمی‌شود.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'bytes',
  },
  labels: { plural: 'حساب ذخیره', singular: 'حساب ذخیره' },
  fields: [
    { name: 'bytes', type: 'number', required: true, defaultValue: 0, label: 'بایت' },
    { name: 'accruedByteMs', type: 'text', required: true, defaultValue: '0', label: 'بایت‌میلی‌ثانیهٔ باز' },
    { name: 'openHourStart', type: 'date', required: true, label: 'شروع ساعت باز' },
    { name: 'accountedAt', type: 'date', required: true, label: 'آخرین محاسبه' },
  ],
  timestamps: true,
}
