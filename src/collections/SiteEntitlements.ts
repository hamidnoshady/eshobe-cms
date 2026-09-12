import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { QUOTA_LABELS, QUOTA_METRICS } from '@/lib/saas/plans'

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
 * Features: catalogue `defaultEnabled` → the plan's granted list → this document's
 * overrides. Quotas: the plan's `limits` → the subscription's `limitOverrides` →
 * this document's `limitOverrides`. Last wins, and `resolveFeatures` /
 * `resolveEntitlement` are the only implementations — a second one in a UI
 * component is how two screens start disagreeing about what a customer has.
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
      'استثناهای هر سایت: امکاناتی که دستی روشن/خاموش شده‌اند و سقف‌هایی که جدا از طرح تغییر کرده‌اند. آخرین لایه در ترتیب حل‌شدن.',
    group: PLATFORM_GROUPS.billing,
    hidden: hiddenFromCustomers,
    useAsTitle: 'site',
  },
  labels: { plural: 'استثناهای سایت', singular: 'استثناهای سایت' },
  fields: [
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
