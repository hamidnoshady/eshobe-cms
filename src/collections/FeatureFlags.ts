import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { slugKey } from '@/lib/saas/plans'

/**
 * The catalogue of switchable capabilities — the vocabulary plans and sites speak.
 *
 * A feature is a *key*, not a code path: `store.checkout`, `blog.comments`,
 * `api.graphql`. The key is what a plan grants, what a site overrides, and what an
 * external app reads out of `GET /api/platform/sites/:id/features`. Keeping the
 * catalogue in a table rather than in code is the point — an operator packaging a
 * new tier at 2am must not need a deploy.
 *
 * Platform-only and unregistered with the multi-tenant plugin, like `plans`: the
 * catalogue is one list for the whole deployment. The *per-site* half lives on
 * `site-entitlements`, which is tenant-scoped.
 *
 * `technicallyAvailable` is whether this deployment can run the feature at all.
 * Commercial ownership comes from the central entitlement projection. Both have
 * to be true, and a per-site technical hold can still force the feature off.
 * `defaultEnabled` remains only for the legacy read used until a projection
 * exists; it does not grant a paid feature once a projection is in place.
 */
export const FeatureFlags: CollectionConfig<'feature-flags'> = {
  slug: 'feature-flags',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['key', 'label', 'category', 'defaultEnabled'],
    description:
      'فهرست امکاناتی که طرح‌ها باز می‌کنند و سایت‌ها می‌توانند استثنا بخورند. کلید، شناسهٔ ماشینی است و در API همین برگردانده می‌شود.',
    group: PLATFORM_GROUPS.product,
    hidden: hiddenFromCustomers,
    useAsTitle: 'label',
  },
  labels: { plural: 'امکانات', singular: 'امکان' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'key',
          type: 'text',
          label: 'کلید',
          required: true,
          unique: true,
          index: true,
          hooks: {
            // Normalised, not validated-and-rejected: `Store.Checkout` and
            // `store.checkout` must never become two features that half the platform
            // disagrees about.
            beforeValidate: [({ value }) => slugKey(value)],
          },
          admin: {
            width: '50',
            description: 'فقط حروف کوچک انگلیسی، عدد، نقطه و خط تیره — مثل store.checkout',
            placeholder: 'store.checkout',
          },
        },
        {
          name: 'label',
          type: 'text',
          label: 'عنوان',
          required: true,
          admin: { width: '50', description: 'نام فارسی برای نمایش در پنل و روی مقایسهٔ طرح‌ها.' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'category',
          type: 'select',
          label: 'دسته',
          defaultValue: 'general',
          options: [
            { label: 'عمومی', value: 'general' },
            { label: 'محتوا', value: 'content' },
            { label: 'فروشگاه', value: 'commerce' },
            { label: 'زیرساخت', value: 'infrastructure' },
            { label: 'یکپارچه‌سازی', value: 'integration' },
          ],
          admin: { width: '50' },
        },
        {
          name: 'defaultEnabled',
          type: 'checkbox',
          label: 'پیش‌فرض بایگانی',
          defaultValue: false,
          admin: {
            width: '25',
            description: 'فقط تا رسیدن تصویر مرکزی معنا دارد. بعد از آن حق تجاری را اعطا نمی‌کند.',
          },
        },
        {
          name: 'technicallyAvailable',
          type: 'checkbox',
          label: 'از نظر فنی در دسترس',
          defaultValue: true,
          admin: {
            width: '25',
            description: 'خاموش یعنی این نسخهٔ سکو قابلیت را اجرا نمی‌کند، حتی اگر مشتری آن را خریده باشد.',
          },
        },
      ],
    },
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
      admin: { description: 'این امکان دقیقاً چه چیزی را باز می‌کند — برای اپراتوری که شش ماه بعد آن را می‌خواند.' },
    },
  ],
  timestamps: true,
}
