import type { CollectionConfig } from 'payload'

import { anyone } from '../access/anyone'
import { scopedPublicRead } from '../access/siteRead'
import { authenticated } from '../access/authenticated'
import { uniqueSlugPerSite } from '../hooks/uniqueSlugPerSite'
import { slugifyField } from '@/lib/slug'
import { slugField } from 'payload'

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
  ],
  hooks: {
    beforeValidate: [uniqueSlugPerSite],
  },
}
