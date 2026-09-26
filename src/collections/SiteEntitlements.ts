import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { QUOTA_LABELS, QUOTA_METRICS } from '@/lib/saas/plans'
import { stripCommercialGrants } from '@/collections/hooks/stripCommercialGrants'

/**
 * The per-site exception sheet: features forced on or off, and quotas moved, for
 * one site regardless of its plan.
 *
 * ## Why this is separate from `subscriptions`
 *
 * A subscription is a *commercial* record with a history — it is what an invoice
 * points at, and it must not be edited to express "turn GraphQL on for this
 * customer while we debug their integration". That is an operational override, it
 * has no price, and it outlives whatever plan the customer is on this month. Mixing
 * the two makes every plan change silently discard the operator's exceptions.
 *
 * ## The resolution order, stated once
 *
 * Commercial grants used to live here. They are now a read-only archive:
 * `stripCommercialGrants` drops `features` and `limitOverrides` on every write.
 * What remains writable is technical: `quotaEnforcement` (warn / enforce / off)
 * and `technicalHolds`, which can disable a feature the projection granted.
 * A hold cannot enable anything.
 *
 * Registered with the multi-tenant plugin (it carries `site`), platform-admin-only
 * on every operation: an entitlement a customer could edit is not an entitlement.
 */
export const SiteEntitlements: CollectionConfig<'site-entitlements'> = {
  slug: 'site-entitlements',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['site', 'quotaEnforcement', 'updatedAt'],
    description:
      'نگه‌داشت فنی و سیاست اعمال سقف. روشن‌کردن امکان پولی و سقف تجاری از تصویر مرکزی می‌آید و اینجا نوشته نمی‌شود.',
    group: PLATFORM_GROUPS.billing,
    hidden: hiddenFromCustomers,
    useAsTitle: 'site',
  },
  labels: { plural: 'استثناهای سایت', singular: 'استثناهای سایت' },
  hooks: {
    beforeChange: [stripCommercialGrants],
  },
  fields: [
    {
      name: 'technicalHolds',
      type: 'json',
      label: 'نگه‌داشت فنی',
      admin: {
        description:
          'فهرستی از کلید امکاناتی که به‌خاطر یک مشکل فنی موقتاً خاموش‌اند. این فهرست هیچ امکانی را روشن نمی‌کند.',
      },
    },
    {
      name: 'features',
      type: 'array',
      label: 'امکانات دستی',
      labels: { plural: 'استثناها', singular: 'استثنا' },
      admin: {
        description:
          'هر ردیف، نظر نهایی دربارهٔ یک امکان برای همین سایت است — چه طرح آن را داده باشد و چه نداده باشد.',
        initCollapsed: false,
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'feature',
              type: 'relationship',
              relationTo: 'feature-flags',
              required: true,
              label: 'امکان',
              admin: { width: '60' },
            },
            {
              name: 'enabled',
              type: 'checkbox',
              label: 'روشن',
              defaultValue: true,
              admin: { width: '40' },
            },
          ],
        },
        {
          name: 'reason',
          type: 'text',
          label: 'دلیل',
          admin: {
            description: 'چرا این استثنا وجود دارد و کِی باید برداشته شود. شش ماه بعد، این تنها سرنخ است.',
          },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'سقف‌های اختصاصی (خالی = از طرح بیاید)',
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'limitOverrides',
          type: 'group',
          label: 'سقف‌ها',
          fields: QUOTA_METRICS.map((metric) => ({
            name: metric,
            type: 'number' as const,
            label: QUOTA_LABELS[metric],
            min: 0,
            admin: { step: 1, width: '33' },
          })),
        },
      ],
    },
    {
      name: 'quotaEnforcement',
      type: 'select',
      label: 'سیاست اعمال سقف',
      defaultValue: 'inherit',
      required: true,
      options: [
        { label: 'مطابق تنظیم سکو', value: 'inherit' },
        { label: 'فقط هشدار (ثبت می‌شود، جلوی کار را نمی‌گیرد)', value: 'warn' },
        { label: 'سخت‌گیرانه (ساخت مورد جدید رد می‌شود)', value: 'enforce' },
        { label: 'بدون محدودیت', value: 'off' },
      ],
      admin: {
        description:
          'برای مشتری‌ای که موقتاً نباید متوقف شود «فقط هشدار» را انتخاب کنید؛ پیش‌فرض، همان سیاست عمومی سکوست.',
      },
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت',
    },
  ],
  timestamps: true,
}
