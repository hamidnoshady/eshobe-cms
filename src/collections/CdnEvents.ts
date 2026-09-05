import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'

/** Immutable operational trace. Provider tokens, request headers and provider
 * response bodies are intentionally never written here; `summary` is generated
 * from the adapter's safe action list. */
export const CdnEvents: CollectionConfig<'cdn-events'> = {
  slug: 'cdn-events',
  access: {
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['createdAt', 'zone', 'operation', 'ok'],
    description:
      'ردّ عملیاتی تغییرات CDN. توکن‌ها و بدنهٔ پاسخ ارائه‌دهنده هرگز در این گزارش ذخیره نمی‌شوند.',
    group: 'زیرساخت',
    useAsTitle: 'operation',
  },
  fields: [
    {
      name: 'zone',
      type: 'relationship',
      relationTo: 'cdn-zones',
      index: true,
      label: 'zone CDN',
      admin: {
        description: 'با حذف zone، رویداد برای گزارش تاریخی باقی می‌ماند و این ارتباط خالی می‌شود.',
      },
    },
    {
      name: 'operation',
      type: 'select',
      required: true,
      options: [
        { label: 'همگام‌سازی', value: 'sync' },
        { label: 'پاک‌سازی کش', value: 'purge' },
      ],
      label: 'عملیات',
    },
    { name: 'ok', type: 'checkbox', required: true, label: 'موفق' },
    { name: 'summary', type: 'textarea', required: true, label: 'خلاصهٔ امن' },
  ],
  labels: { singular: 'رویداد CDN', plural: 'رویدادهای CDN' },
  timestamps: true,
}
