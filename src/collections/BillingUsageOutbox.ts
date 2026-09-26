import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { BILLING_METERS } from '@/billing/meters/registry'

/**
 * Durable financial usage waiting to be accepted by central Billing.
 *
 * A row is not "sent" because this process tried. It is sent when the central
 * acknowledgement names the event as accepted or duplicate. Restart, timeout
 * and a dead billing platform leave the row here.
 *
 * Append-only for accepted events: a wrong quantity becomes a correction row,
 * not an edit of a sent one. Pending rows may still be updated, because central
 * Billing has not accepted them.
 */
export const BillingUsageOutbox: CollectionConfig = {
  slug: 'billing-usage-outbox',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['site', 'meterKey', 'quantity', 'status', 'periodStart', 'eventId'],
    description:
      'رویدادهای مصرفی که برای صورت‌حساب مرکزی صف شده‌اند. این جدول قیمت محاسبه نمی‌کند؛ فقط مقدار سنجه را تا گرفتن رسید نگه می‌دارد.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'eventId',
  },
  labels: { plural: 'خروجی مصرف', singular: 'رویداد مصرف' },
  fields: [
    {
      name: 'eventId',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      label: 'شناسهٔ رویداد',
    },
    {
      name: 'meterKey',
      type: 'select',
      required: true,
      index: true,
      label: 'سنجه',
      options: BILLING_METERS.map((meter) => ({ label: meter.key, value: meter.key })),
    },
    {
      name: 'quantity',
      type: 'number',
      required: true,
      label: 'مقدار',
    },
    {
      name: 'unit',
      type: 'text',
      required: true,
      label: 'واحد',
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'measurement',
      label: 'نوع',
      options: [
        { label: 'اندازه‌گیری', value: 'measurement' },
        { label: 'اصلاحیه', value: 'correction' },
      ],
    },
    {
      name: 'resourceType',
      type: 'text',
      label: 'نوع منبع',
    },
    {
      name: 'resourceId',
      type: 'text',
      label: 'شناسهٔ منبع',
    },
    {
      name: 'periodStart',
      type: 'date',
      required: true,
      index: true,
      label: 'شروع دوره',
    },
    {
      name: 'periodEnd',
      type: 'date',
      required: true,
      label: 'پایان دوره',
    },
    {
      name: 'occurredAt',
      type: 'date',
      required: true,
      label: 'زمان رویداد',
    },
    {
      name: 'dimensions',
      type: 'json',
      label: 'ابعاد',
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      label: 'وضعیت',
      options: [
        { label: 'در انتظار', value: 'pending' },
        { label: 'در حال ارسال', value: 'sending' },
        { label: 'ارسال‌شده', value: 'sent' },
        { label: 'ناموفق', value: 'failed' },
        { label: 'بن‌بست', value: 'dead_letter' },
      ],
    },
    {
      name: 'attemptCount',
      type: 'number',
      defaultValue: 0,
      label: 'تعداد تلاش',
    },
    {
      name: 'nextAttemptAt',
      type: 'date',
      index: true,
      label: 'تلاش بعدی',
    },
    {
      name: 'lastAttemptAt',
      type: 'date',
      label: 'آخرین تلاش',
    },
    {
      name: 'lastError',
      type: 'textarea',
      label: 'آخرین خطا',
    },
    {
      name: 'sentAt',
      type: 'date',
      index: true,
      label: 'زمان پذیرش',
    },
    {
      name: 'correctsEventId',
      type: 'text',
      label: 'رویداد اصلاح‌شده',
    },
    {
      name: 'correctionReason',
      type: 'textarea',
      label: 'دلیل اصلاح',
    },
    {
      name: 'actor',
      type: 'text',
      label: 'منبع اصلاح',
    },
    {
      name: 'leaseToken',
      type: 'text',
      label: 'اجارهٔ ارسال',
      admin: { readOnly: true },
    },
    {
      name: 'exportedQuantity',
      type: 'number',
      label: 'مقدار پذیرفته‌شده',
      admin: { description: 'مقداری که مرکزی پذیرفته است. اختلاف بعدی یک اصلاحیه است، نه ویرایش این ردیف.' },
    },
  ],
  timestamps: true,
}
