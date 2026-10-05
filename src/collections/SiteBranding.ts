import type { CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { scopedPublicRead } from '@/access/siteRead'
import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { revalidateSiteGlobal, revalidateSiteGlobalDelete } from '@/hooks/revalidateSiteGlobal'

/** Theme-independent public identity. Logos remain media relationships and no field accepts CSS or HTML. */
export const SiteBranding: CollectionConfig<'site-branding'> = {
  slug: 'site-branding',
  access: {
    create: authenticated,
    delete: authenticated,
    read: scopedPublicRead(),
    update: authenticated,
  },
  admin: { group: SITE_CONTENT_GROUP, hidden: hiddenFromOperators, useAsTitle: 'displayName' },
  labels: { singular: 'هویت بصری', plural: 'هویت بصری' },
  /**
   * Unnamed tabs are presentational only — every field keeps its top-level path, so the
   * stored shape, `GET /api/site`'s `branding` and every theme reading it are unchanged.
   */
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'نام و شعار',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'displayName',
                  type: 'text',
                  required: true,
                  label: 'نام نمایشی',
                  admin: { width: '50%' },
                },
                {
                  name: 'shortName',
                  type: 'text',
                  label: 'نام کوتاه',
                  maxLength: 40,
                  admin: {
                    description: 'برای سربرگ موبایل و جاهای تنگ؛ حداکثر ۴۰ نویسه.',
                    width: '50%',
                  },
                },
              ],
            },
            { name: 'tagline', type: 'text', localized: true, label: 'شعار' },
          ],
        },
        {
          label: 'نشان‌ها',
          description: 'SVG و تصاویر معمولی پشتیبانی می‌شوند. هر نشانی که خالی بماند از «نشان اصلی» جایگزین می‌شود.',
          fields: [
            {
              name: 'homeLogo',
              type: 'upload',
              relationTo: 'media',
              label: 'نشان صفحهٔ نخست',
              admin: {
                description:
                  'نشان بزرگ وسط صفحهٔ اول پوسته که با انیمیشن ورودی نمایش داده می‌شود. فایل SVG بهترین نتیجه را دارد.',
              },
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'primaryLogo',
                  type: 'upload',
                  relationTo: 'media',
                  label: 'نشان اصلی',
                  admin: { description: 'سربرگ صفحه‌های داخلی.', width: '50%' },
                },
                {
                  name: 'compactLogo',
                  type: 'upload',
                  relationTo: 'media',
                  label: 'نشان فشرده',
                  admin: { description: 'نسخهٔ کوچک برای موبایل.', width: '50%' },
                },
              ],
            },
            {
              type: 'row',
              fields: [
                {
                  name: 'lightLogo',
                  type: 'upload',
                  relationTo: 'media',
                  label: 'نشان روشن',
                  admin: { description: 'برای زمینهٔ تیره.', width: '50%' },
                },
                {
                  name: 'darkLogo',
                  type: 'upload',
                  relationTo: 'media',
                  label: 'نشان تیره',
                  admin: { description: 'برای زمینهٔ روشن.', width: '50%' },
                },
              ],
            },
          ],
        },
        {
          label: 'فاوآیکون و اشتراک‌گذاری',
          fields: [
            {
              type: 'row',
              fields: [
                {
                  name: 'favicon',
                  type: 'upload',
                  relationTo: 'media',
                  label: 'فاوآیکون',
                  admin: { description: 'مربعی، حداقل ۱۸۰×۱۸۰ پیکسل.', width: '50%' },
                },
                {
                  name: 'socialImage',
                  type: 'upload',
                  relationTo: 'media',
                  label: 'تصویر پیش‌فرض شبکه‌های اجتماعی',
                  admin: { description: 'پیشنهاد: ۱۲۰۰×۶۳۰ پیکسل.', width: '50%' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  hooks: {
    afterChange: [revalidateSiteGlobal('branding')],
    afterDelete: [revalidateSiteGlobalDelete('branding')],
  },
  timestamps: true,
}
