import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { QUOTA_LABELS, QUOTA_METRICS } from '@/lib/saas/plans'

/**
 * Metered usage that cannot be counted from the content tables.
 *
 * Most quotas are a `count` away — how many pages, how many products, how many
 * media files. Two are not: **API requests** and anything else that is an *event*
 * rather than a row. Nothing stores a request after it has been served, so a
 * monthly API quota has to be accumulated as it happens.
 *
 * ## One row per (site, metric, period), incremented — not one row per event
 *
 * A row per API call would be the most accurate design and the wrong one: at any
 * real traffic it is the largest table in the database within a week, it makes the
 * quota check a `count` over millions of rows on the hot path, and it retains a
 * per-request trail nobody asked for. A counter per period answers the only
 * question the quota system asks ("how many this month?") in one indexed read.
 *
 * Precision is traded deliberately: concurrent increments can lose a count, because
 * this is a read-modify-write through the Local API rather than an atomic `UPDATE …
 * SET value = value + 1` (raw SQL stays in migrations — CLAUDE.md). For a *quota*
 * that is the right side to err on: undercounting means a customer occasionally
 * gets a few requests more than they paid for, where overcounting means a customer
 * is blocked from something they did pay for.
 */
export const UsageRecords: CollectionConfig<'usage-records'> = {
  slug: 'usage-records',
  access: {
    // Written by `recordUsage` with `overrideAccess`, so the counter cannot be set
    // from outside to fake a customer under their limit.
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['site', 'metric', 'period', 'value', 'updatedAt'],
    description:
      'شمارندهٔ مصرف برای سنجه‌هایی که از روی جدول‌ها قابل شمارش نیستند (مثل تعداد درخواست API). هر ردیف، یک سنجه در یک دورهٔ ماهانه است.',
    group: PLATFORM_GROUPS.billing,
    hidden: hiddenFromCustomers,
    useAsTitle: 'metric',
  },
  labels: { plural: 'مصرف', singular: 'مصرف' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'metric',
          type: 'select',
          label: 'سنجه',
          required: true,
          index: true,
          options: QUOTA_METRICS.map((metric) => ({ label: QUOTA_LABELS[metric], value: metric })),
          admin: { width: '40' },
        },
        {
          name: 'period',
          type: 'text',
          label: 'دوره',
          required: true,
          index: true,
          admin: {
            width: '30',
            description: 'ماه میلادی به شکل YYYY-MM — کلید شمارنده، نه تاریخی برای خواندن.',
          },
        },
        {
          name: 'value',
          type: 'number',
          label: 'مقدار',
          defaultValue: 0,
          required: true,
          admin: { width: '30', step: 1 },
        },
      ],
    },
    {
      name: 'lastEventAt',
      type: 'date',
      label: 'آخرین رویداد',
      admin: { description: 'برای تشخیص شمارندهٔ متوقف‌شده از شمارندهٔ صفر.' },
    },
  ],
  timestamps: true,
}
