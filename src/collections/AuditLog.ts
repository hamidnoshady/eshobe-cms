import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { PLATFORM_EVENT_OPTIONS } from '@/lib/saas/events'

/**
 * Who did what, on the control plane.
 *
 * `GET /api/platform/events` already derives a feed from ordinary rows — a site's
 * `updatedAt`, an order's status. That feed answers "what is the current state and
 * when did it last change", and it cannot answer the question an operator actually
 * has after an incident: **who** suspended this site, from which key, and what did
 * it look like before. A derived feed loses that the moment the row changes again.
 * So this collection is the durable half, written at the moment of the action.
 *
 * ## Append-only, on purpose
 *
 * `create` is `false` from outside (rows are written by `recordAudit` with
 * `overrideAccess: true`), `update` is `false` for everyone, and `delete` is
 * platform-admin so retention can be pruned. An audit trail an administrator can
 * quietly edit is not an audit trail — and the same rule is already applied to
 * `cdn-events` and `reseller-domain-events`, which this follows deliberately.
 *
 * ## What is never written here
 *
 * No credentials, no request headers, no full request bodies, no decrypted secret
 * of any kind. `changes` holds field *names* and short scalar before/after values,
 * truncated — enough to reconstruct a decision, never enough to be a second copy of
 * the data. The same rule `cdn-events` states for provider tokens.
 */
export const AuditLog: CollectionConfig<'audit-log'> = {
  slug: 'audit-log',
  access: {
    // Written only through `recordAudit` (overrideAccess), never by an API caller —
    // a forgeable audit entry is worse than none.
    create: () => false,
    delete: platformAdmin,
    read: platformAdmin,
    update: () => false,
  },
  admin: {
    defaultColumns: ['createdAt', 'action', 'actorEmail', 'site', 'summary'],
    description:
      'ردّ تغییرات سکو: چه کسی، چه زمانی، چه چیزی را تغییر داد. فقط افزودنی است؛ هیچ رمز، هدر یا بدنهٔ کامل درخواستی ذخیره نمی‌شود.',
    group: PLATFORM_GROUPS.operations,
    hidden: hiddenFromCustomers,
    useAsTitle: 'summary',
  },
  labels: { plural: 'ردّ تغییرات', singular: 'ردّ تغییر' },
  fields: [
    {
      name: 'action',
      type: 'select',
      label: 'رویداد',
      required: true,
      index: true,
      options: PLATFORM_EVENT_OPTIONS,
    },
    {
      name: 'summary',
      type: 'text',
      label: 'خلاصه',
      required: true,
      admin: { description: 'یک جملهٔ خوانا؛ همان چیزی که در فهرست دیده می‌شود.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'actorType',
          type: 'select',
          label: 'نوع عامل',
          defaultValue: 'user',
          required: true,
          options: [
            { label: 'کاربر', value: 'user' },
            { label: 'کلید API', value: 'apiKey' },
            { label: 'سامانه', value: 'system' },
          ],
          admin: { width: '33' },
        },
        {
          name: 'actorEmail',
          type: 'text',
          label: 'عامل',
          index: true,
          admin: {
            width: '34',
            description: 'ایمیل کاربر یا نام کلید. برای کارهای زمان‌بندی‌شده خالی است.',
          },
        },
        {
          name: 'ip',
          type: 'text',
          label: 'نشانی IP',
          admin: { width: '33', description: 'از هدر پروکسی خوانده می‌شود؛ برای پیگیری، نه برای احراز هویت.' },
        },
      ],
    },
    {
      name: 'site',
      type: 'relationship',
      relationTo: 'sites',
      label: 'سایت',
      index: true,
      admin: { description: 'خالی یعنی رویداد سطح سکو بوده، نه مربوط به یک سایت.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'targetCollection',
          type: 'text',
          label: 'مجموعه',
          admin: { width: '50', description: 'کدام مجموعه تغییر کرد — مثلاً subscriptions.' },
        },
        {
          name: 'targetId',
          type: 'text',
          label: 'شناسهٔ سند',
          index: true,
          admin: { width: '50' },
        },
      ],
    },
    {
      name: 'changes',
      type: 'json',
      label: 'تغییرها',
      admin: {
        description:
          'فقط نام فیلد و مقدار کوتاه قبل/بعد، بریده‌شده. اعتبارنامه‌ها، هدرها و بدنهٔ کامل درخواست هرگز اینجا نوشته نمی‌شوند.',
      },
    },
  ],
  timestamps: true,
}
