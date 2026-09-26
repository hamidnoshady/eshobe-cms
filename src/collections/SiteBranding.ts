import type { CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { scopedPublicRead } from '@/access/siteRead'
import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { revalidateSiteGlobal } from '@/hooks/revalidateSiteGlobal'

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
  fields: [
    { name: 'displayName', type: 'text', required: true, label: 'نام نمایشی' },
    { name: 'shortName', type: 'text', label: 'نام کوتاه', maxLength: 40 },
    { name: 'tagline', type: 'text', localized: true, label: 'شعار' },
    {
      type: 'row',
      fields: [
        { name: 'primaryLogo', type: 'upload', relationTo: 'media', label: 'نشان اصلی' },
        { name: 'compactLogo', type: 'upload', relationTo: 'media', label: 'نشان فشرده' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'lightLogo', type: 'upload', relationTo: 'media', label: 'نشان روشن' },
        { name: 'darkLogo', type: 'upload', relationTo: 'media', label: 'نشان تیره' },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'favicon', type: 'upload', relationTo: 'media', label: 'فاوآیکون' },
        {
          name: 'socialImage',
          type: 'upload',
          relationTo: 'media',
          label: 'تصویر پیش‌فرض شبکه‌های اجتماعی',
        },
      ],
    },
  ],
  hooks: { afterChange: [revalidateSiteGlobal('branding')] },
  timestamps: true,
}
