import type { CollectionConfig } from 'payload'

import { anyone } from '../access/anyone'
import { authenticated } from '../access/authenticated'
import { uniqueSlugPerSite } from '../hooks/uniqueSlugPerSite'
import { slugifyField } from '@/lib/slug'
import { slugField } from 'payload'

export const Categories: CollectionConfig = {
  slug: 'categories',
  access: {
    create: authenticated,
    delete: authenticated,
    read: anyone,
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
