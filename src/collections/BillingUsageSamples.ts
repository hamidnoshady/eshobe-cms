import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { BILLING_METERS } from '@/billing/meters/registry'

/**
 * Additive measurements that have not yet been folded into one hourly outbox
 * event. Creates only — a sample is never edited — so two replicas can both
 * write the same hour without losing a count.
 */
export const BillingUsageSamples: CollectionConfig = {
  slug: 'billing-usage-samples',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['site', 'meterKey', 'quantity', 'periodStart'],
    description: 'نمونه‌های خام مصرف، پیش از جمع‌شدن در یک رویداد ساعتی. این جدول صورتحساب نیست.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'meterKey',
  },
  labels: { plural: 'نمونه‌های مصرف', singular: 'نمونهٔ مصرف' },
  fields: [
    {
      name: 'meterKey',
      type: 'select',
      required: true,
      index: true,
      label: 'سنجه',
      options: BILLING_METERS.map((meter) => ({ label: meter.key, value: meter.key })),
    },
    { name: 'quantity', type: 'number', required: true, label: 'مقدار' },
    { name: 'unit', type: 'text', required: true, label: 'واحد' },
    { name: 'periodStart', type: 'date', required: true, index: true, label: 'شروع ساعت' },
    { name: 'periodEnd', type: 'date', required: true, label: 'پایان ساعت' },
    { name: 'occurredAt', type: 'date', required: true, label: 'زمان' },
    { name: 'resourceType', type: 'text', label: 'نوع منبع' },
    { name: 'resourceId', type: 'text', label: 'شناسهٔ منبع' },
    { name: 'dimensions', type: 'json', label: 'ابعاد' },
    { name: 'source', type: 'text', label: 'منبع اندازه‌گیری' },
  ],
  timestamps: true,
}
