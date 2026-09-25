import type { CollectionConfig } from 'payload'

import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { isHexColor } from '@/lib/theme'
import { slugKey } from '@/lib/saas/plans'

const hexColor = (value: unknown): string | true =>
  isHexColor(value) || value == null ? true : 'رنگ را به شکل کد هکس بنویسید، مثل #0f766e.'

/**
 * The theme catalogue: the design presets an operator offers, and a new site is
 * built from.
 *
 * ## Why this is not `theme`
 *
 * `theme` (the collection) is **one document per site** — the tokens that site
 * actually renders with, edited by its own staff. This is the platform's *library*
 * of starting points: "فروشگاهی تیره", "شرکتی روشن". One is a customer's current
 * colours, the other is the catalogue those colours were chosen from. Conflating
 * them means editing the catalogue repaints live customer sites, which is precisely
 * the accident this separation prevents.
 *
 * Applying a template writes the tokens onto a site's `theme` document once
 * (`POST /api/platform/sites/:id/theme`). It is a copy, deliberately: a live link
 * would mean an operator's tweak to a shared preset silently changes twenty
 * customers' branding, and nobody could tell which sites had been customised since.
 *
 * `siteTypes` gates which presets `provisionSite` offers, the same registry shape
 * `src/blocks/index.ts` uses for blocks — a typed list, not free text, so a
 * misspelt type cannot quietly hide a template from every site.
 */
export const ThemeTemplates: CollectionConfig<'theme-templates'> = {
  slug: 'theme-templates',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: platformAdmin,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['name', 'key', 'active', 'siteTypes'],
    description:
      'کتابخانهٔ پوسته‌های آماده که سایت جدید از روی آن‌ها ساخته می‌شود. اعمال یک پوسته، یک کپی است — ویرایش این فهرست، سایت‌های موجود را تغییر نمی‌دهد.',
    group: PLATFORM_GROUPS.product,
    hidden: hiddenFromCustomers,
    useAsTitle: 'name',
  },
  labels: { plural: 'پوسته‌های آماده', singular: 'پوستهٔ آماده' },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'name',
          type: 'text',
          label: 'نام',
          required: true,
          admin: { width: '50' },
        },
        {
          name: 'key',
          type: 'text',
          label: 'کلید',
          required: true,
          unique: true,
          index: true,
          hooks: { beforeValidate: [({ value, data }) => slugKey(value || data?.name)] },
          admin: { width: '50', description: 'شناسهٔ ماشینی؛ در API ساخت سایت با همین نام ارسال می‌شود.' },
        },
      ],
    },
    {
      name: 'description',
      type: 'textarea',
      label: 'توضیح',
    },
    {
      type: 'row',
      fields: [
        {
          name: 'active',
          type: 'checkbox',
          label: 'در دسترس',
          defaultValue: true,
          admin: { width: '50', description: 'خاموش یعنی در ساخت سایت جدید پیشنهاد نمی‌شود؛ سایت‌های موجود دست‌نخورده‌اند.' },
        },
        {
          name: 'isDefault',
          type: 'checkbox',
          label: 'پیش‌فرض',
          defaultValue: false,
          admin: { width: '50', description: 'وقتی هنگام ساخت سایت پوسته‌ای انتخاب نشده باشد، همین اعمال می‌شود.' },
        },
      ],
    },
    {
      name: 'siteTypes',
      type: 'select',
      label: 'برای نوع سایت',
      hasMany: true,
      defaultValue: ['business', 'portfolio', 'store'],
      options: [
        { label: 'کسب‌وکار', value: 'business' },
        { label: 'نمونه‌کار', value: 'portfolio' },
        { label: 'فروشگاه', value: 'store' },
      ],
      admin: { description: 'فقط برای این نوع‌ها در فهرست ساخت سایت ظاهر می‌شود.' },
    },
    {
      type: 'collapsible',
      label: 'توکن‌های طراحی',
      admin: { initCollapsed: false },
      fields: [
        {
          name: 'tokens',
          type: 'group',
          label: 'توکن‌ها',
          // The exact field set of the `theme` collection. It is duplicated rather than
          // shared because the two have different *lifetimes*: a token added to a live
          // site's theme must not require every stored template to be migrated in the
          // same commit, and `applyThemeTemplate` copies only the keys it recognises.
          fields: [
            {
              type: 'row',
              fields: [
                { name: 'primary', type: 'text', label: 'رنگ اصلی', defaultValue: '#0f766e', validate: hexColor, admin: { width: '50' } },
                { name: 'accent', type: 'text', label: 'رنگ تأکید', defaultValue: '#f59e0b', validate: hexColor, admin: { width: '50' } },
              ],
            },
            {
              type: 'row',
              fields: [
                { name: 'background', type: 'text', label: 'پس‌زمینه', defaultValue: '#ffffff', validate: hexColor, admin: { width: '50' } },
                { name: 'foreground', type: 'text', label: 'متن', defaultValue: '#0a0a0a', validate: hexColor, admin: { width: '50' } },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'radius',
                  type: 'select',
                  label: 'گردی گوشه‌ها',
                  defaultValue: 'md',
                  options: [
                    { label: 'بدون گردی', value: 'none' },
                    { label: 'کم', value: 'sm' },
                    { label: 'متوسط', value: 'md' },
                    { label: 'زیاد', value: 'lg' },
                  ],
                  admin: { width: '50' },
                },
                {
                  name: 'lineHeight',
                  type: 'number',
                  label: 'فاصله خطوط',
                  defaultValue: 1.8,
                  min: 1.4,
                  max: 2.4,
                  admin: { step: 0.1, width: '50', description: 'فارسی به فضای عمودی بیشتری نیاز دارد؛ کمتر از ۱٫۶ توصیه نمی‌شود.' },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'preview',
      type: 'upload',
      relationTo: 'media',
      label: 'تصویر پیش‌نمایش',
      admin: { description: 'اختیاری — برای فهرست انتخاب پوسته در ساخت سایت.' },
    },
  ],
  timestamps: true,
}
