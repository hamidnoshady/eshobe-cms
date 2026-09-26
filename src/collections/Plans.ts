import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { PLATFORM_GROUPS } from '@/admin/visibility'
import { freezeCommercialWrites } from '@/collections/hooks/freezeCommercialWrites'
import { currencyCodes, currencies } from '@/lib/money'
import { QUOTA_LABELS, QUOTA_METRICS } from '@/lib/saas/plans'
import { slugify } from '@/lib/slug'

/**
 * Legacy archive of plan rows from when this CMS kept a commercial catalogue.
 * Writes are frozen. cafe-restaurant-pos owns plans, prices and allowances.
 * The columns stay so historical rows can be read during migration; they are
 * not configuration.
 *
 * Deliberately **not** in the multi-tenant plugin's `collections` map, for the same
 * reason `api-keys` and `storage-connections` are not: a plan is the platform's own
 * catalogue, not a site's content. Every site points *at* a plan through its
 * subscription; no site owns one.
 *
 * ## Quotas are a fixed list, not free-form rows
 *
 * `QUOTA_METRICS` in `src/lib/saas/plans.ts` is the closed set, and the fields below
 * are generated from it. A free-form `{ key, limit }` array would let a typo
 * (`pagess: 10`) save cleanly and then never be enforced by anything — a limit the
 * operator believes exists and the enforcement hook has never heard of. Generated
 * fields cannot be misspelt, and adding a metric is one entry in that tuple.
 *
 * **A blank or zero limit means unlimited** (`normalizeLimit`). That default is
 * chosen in the direction that fails safe for the *customer*: a plan row saved
 * before somebody filled in the numbers must not lock a paying site out of
 * publishing.
 *
 * ## Price
 *
 * Minor units and a currency, exactly like `products` and `orders` — Toman has no
 * subunit, so `2_500_000` is ۲٬۵۰۰٬۰۰۰ تومان. Storing a float here would put the
 * platform's own revenue on a different footing from its customers' and eventually
 * produce an invoice ending in `…0000004`.
 */
export const Plans: CollectionConfig<'plans'> = {
  slug: 'plans',
  access: {
    create: () => false,
    delete: () => false,
    read: platformAdmin,
    update: () => false,
  },
  hooks: { beforeValidate: [freezeCommercialWrites] },
  admin: {
    defaultColumns: ['name', 'code', 'price', 'interval', 'active', 'public'],
    description:
      'بایگانی فقط‌خواندنیِ طرح‌های قدیمی. قیمت و طرح تجاری در پلتفرم اشوب است، نه اینجا.',
    group: PLATFORM_GROUPS.billing,
    hidden: true,
    useAsTitle: 'name',
  },
  labels: { plural: 'طرح‌های اشتراک', singular: 'طرح اشتراک' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام طرح',
          required: true,
          admin: { width: '60', description: 'همان چیزی که روی صورتحساب مشتری چاپ می‌شود؛ مثلاً «حرفه‌ای».' },
        },
        {
          name: 'code',
          type: 'text',
          label: 'کد طرح',
          required: true,
          unique: true,
          index: true,
          hooks: {
            // The code is what an external app matches on (`plan: "pro"` in a
            // provisioning call), so it is normalised on write rather than trusted:
            // «حرفه‌ای» typed into this box would otherwise become a key nothing can
            // send in a URL.
            // `slugify`, not `slugifyField` — the latter takes Payload's
            // `{ valueToSlugify }` wrapper for `slugField()` and returns '' for a bare
            // string, which would make every plan fail its own `required` check.
            beforeValidate: [
              ({ data, value }) =>
                slugify(typeof value === 'string' && value ? value : String(data?.name ?? '')),
            ],
          },
          admin: {
            width: '40',
            description: 'شناسهٔ ماشینی و پایدار؛ در API و در اتصال به برنامه‌های دیگر همین استفاده می‌شود.',
          },
        },
      ],
    },
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
      admin: { description: 'یک یا دو جمله برای صفحهٔ فروش و برای خود اپراتور.' },
    },
    {
      type: 'row',
      fields: [
        {
          name: 'price',
          type: 'number',
          label: 'قیمت (واحد خرد)',
          defaultValue: 0,
          min: 0,
          required: true,
          admin: {
            width: '33',
            description: 'عدد صحیح در واحد خردِ همان ارز — برای تومان یعنی خودِ تومان. صفر یعنی رایگان.',
            step: 1,
          },
        },
        {
          name: 'currency',
          type: 'select',
          label: 'ارز',
          defaultValue: 'IRT',
          required: true,
          options: currencyCodes.map((code) => ({
            label: code === 'IRT' ? 'تومان (پیش‌فرض)' : `${currencies[code].unit.fa} (${code})`,
            value: code,
          })),
          admin: { width: '33' },
        },
        {
          name: 'interval',
          type: 'select',
          label: 'دورهٔ صورتحساب',
          defaultValue: 'monthly',
          required: true,
          options: [
            { label: 'ماهانه', value: 'monthly' },
            { label: 'سه‌ماهه', value: 'quarterly' },
            { label: 'سالانه', value: 'yearly' },
            { label: 'دائمی (یک‌بار پرداخت)', value: 'lifetime' },
          ],
          admin: { width: '34' },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'trialDays',
          type: 'number',
          label: 'روزهای آزمایشی',
          defaultValue: 0,
          min: 0,
          max: 365,
          admin: { width: '33', description: 'صفر یعنی بدون دورهٔ آزمایشی.' },
        },
        {
          name: 'active',
          type: 'checkbox',
          label: 'قابل فروش',
          defaultValue: true,
          admin: {
            width: '33',
            description: 'خاموش یعنی اشتراک تازه روی این طرح ساخته نمی‌شود؛ اشتراک‌های موجود دست‌نخورده می‌مانند.',
          },
        },
        {
          name: 'public',
          type: 'checkbox',
          label: 'نمایش در فهرست عمومی',
          defaultValue: true,
          admin: {
            width: '34',
            description: 'طرح‌های خصوصی (قرارداد اختصاصی) را خاموش بگذارید؛ فقط اپراتور می‌تواند آن‌ها را تخصیص دهد.',
          },
        },
      ],
    },
    {
      name: 'sortOrder',
      type: 'number',
      label: 'ترتیب نمایش',
      defaultValue: 100,
      admin: { description: 'کوچک‌تر، بالاتر. برای چیدمان جدول مقایسهٔ طرح‌ها.', position: 'sidebar' },
    },
    {
      type: 'collapsible',
      label: 'سقف‌ها (خالی یا صفر = بی‌نهایت)',
      admin: { initCollapsed: false },
      fields: [
        {
          name: 'limits',
          type: 'group',
          label: 'سقف‌ها',
          // Generated from the one closed list every enforcement path reads. A hand-written
          // field here that is not in `QUOTA_METRICS` is a limit nothing enforces.
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
      name: 'features',
      type: 'relationship',
      relationTo: 'feature-flags',
      hasMany: true,
      label: 'امکانات این طرح',
      admin: {
        description:
          'امکاناتی که این طرح روشن می‌کند. ترتیب حل‌شدن: پیش‌فرضِ فهرست امکانات، بعد طرح، بعد تنظیم اختصاصی همان سایت.',
      },
    },
    {
      name: 'notes',
      type: 'textarea',
      label: 'یادداشت داخلی',
      admin: { description: 'برای اپراتور؛ در هیچ API عمومی و روی هیچ صورتحسابی نمایش داده نمی‌شود.' },
    },
  ],
  timestamps: true,
}
