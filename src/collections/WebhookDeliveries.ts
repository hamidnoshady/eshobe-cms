import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { PLATFORM_EVENT_OPTIONS } from '@/lib/saas/events'

/**
 * One attempted delivery. The answer to "did they get it?", which is the only
 * question anybody ever asks about a webhook.
 *
 * Immutable like `cdn-events`: written by the dispatcher, never edited. What it
 * stores is deliberately asymmetric — the **request** body is kept (it is the
 * platform's own event, and without it a failure cannot be diagnosed or replayed),
 * the **response** is kept only as a status code and a truncated first kilobyte. A
 * receiver's response can contain anything at all, including its own secrets in an
 * error page, and a log that mirrors it wholesale turns somebody else's bug into
 * this database's liability.
 *
 * Signatures are never stored. The signature is derived from the secret, and a
 * stored one plus a stored body is a slow leak of the key.
 */
export const WebhookDeliveries: CollectionConfig<'webhook-deliveries'> = {
  slug: 'webhook-deliveries',
  access: {
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['createdAt', 'webhook', 'event', 'ok', 'statusCode', 'durationMs'],
    description:
      'گزارش ارسال وب‌هوک‌ها. بدنهٔ رویداد ذخیره می‌شود تا قابل بازفرست باشد؛ از پاسخ گیرنده فقط کد وضعیت و یک کیلوبایت اول نگه داشته می‌شود و امضا هرگز ذخیره نمی‌شود.',
    group: PLATFORM_GROUPS.integrations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'event',
  },
  labels: { plural: 'ارسال‌های وب‌هوک', singular: 'ارسال وب‌هوک' },
  fields: [
    {
      name: 'webhook',
      type: 'relationship',
      relationTo: 'webhooks',
      index: true,
      label: 'وب‌هوک',
      admin: { description: 'با حذف وب‌هوک، گزارش برای پیگیری تاریخی می‌ماند و این ارتباط خالی می‌شود.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'event',
          type: 'select',
          label: 'رویداد',
          required: true,
          index: true,
          options: PLATFORM_EVENT_OPTIONS,
          admin: { width: '40' },
        },
        {
          name: 'ok',
          type: 'checkbox',
          label: 'موفق',
          required: true,
          index: true,
          admin: { width: '20' },
        },
        {
          name: 'statusCode',
          type: 'number',
          label: 'کد وضعیت',
          admin: { width: '20', description: 'خالی یعنی اصلاً پاسخی نرسید (تایم‌اوت یا خطای شبکه).' },
        },
        {
          name: 'durationMs',
          type: 'number',
          label: 'مدت (میلی‌ثانیه)',
          admin: { width: '20' },
        },
      ],
    },
    {
      name: 'attempt',
      type: 'number',
      label: 'شمارهٔ تلاش',
      defaultValue: 1,
    },
    {
      name: 'requestBody',
      type: 'json',
      label: 'بدنهٔ ارسالی',
      admin: { description: 'همان رویدادی که سکو تولید کرد — برای بازفرست دقیقاً همین دوباره فرستاده می‌شود.' },
    },
    {
      name: 'responseBody',
      type: 'textarea',
      label: 'پاسخ گیرنده (بریده)',
      admin: { description: 'حداکثر یک کیلوبایت. پاسخ کامل ذخیره نمی‌شود.' },
    },
    {
      name: 'error',
      type: 'text',
      label: 'خطا',
    },
  ],
  timestamps: true,
}
