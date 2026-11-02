import type { CollectionConfig } from 'payload'

import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { anyone } from '../access/anyone'
import { scopedPublicRead } from '../access/siteRead'
import { authenticated } from '../access/authenticated'
import { uniqueSlugPerSite } from '../hooks/uniqueSlugPerSite'
import { slugifyField } from '@/lib/slug'
import { slugField } from 'payload'
import { revalidateSiteGlobal, revalidateSiteGlobalDelete } from '@/hooks/revalidateSiteGlobal'
import { migrationSourceField } from './fields/migrationSource'
import { validateCategoryParent } from './hooks/validateCategoryParent'

export const Categories: CollectionConfig = {
  slug: 'categories',
  access: {
    create: authenticated,
    delete: authenticated,
    // Public and host-scoped: a post list is a taxonomy of one customer's content,
    // not of the platform's (`src/access/siteRead.ts`).
    read: scopedPublicRead(anyone),
    update: authenticated,
  },
  admin: {
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
    useAsTitle: 'title',
  },
  labels: {
    singular: 'دسته‌بندی',
    plural: 'دسته‌بندی‌ها',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      label: 'عنوان',
      required: true,
      localized: true,
    },
    slugField({
      disableUnique: true,
      localized: true,
      position: undefined,
      slugify: slugifyField,
    }),
    {
      name: 'parent',
      type: 'relationship',
      label: 'دسته والد',
      admin: {
        description: 'درخت دسته‌های وردپرس در مهاجرت همین‌جا حفظ می‌شود؛ دسته بدون والد، ریشه است.',
      },
      relationTo: 'categories',
    },
    migrationSourceField({ optional: true }),
  ],
  hooks: {
    afterChange: [revalidateSiteGlobal('category')],
    afterDelete: [revalidateSiteGlobalDelete('category')],
    beforeValidate: [uniqueSlugPerSite, validateCategoryParent],
  },
}
