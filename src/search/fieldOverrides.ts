import { Field } from 'payload'

export const searchFields: Field[] = [
  {
    name: 'slug',
    type: 'text',
    index: true,
    admin: {
      readOnly: true,
    },
  },
  {
    name: 'meta',
    label: 'فراداده (SEO)',
    type: 'group',
    index: true,
    admin: {
      readOnly: true,
    },
    fields: [
      {
        type: 'text',
        name: 'title',
        label: 'عنوان',
      },
      {
        type: 'text',
        name: 'description',
        label: 'توضیحات',
      },
      {
        name: 'image',
        label: 'تصویر',
        type: 'upload',
        relationTo: 'media',
      },
    ],
  },
  {
    label: 'دسته‌بندی‌ها',
    name: 'categories',
    type: 'array',
    admin: {
      readOnly: true,
    },
    fields: [
      {
        name: 'relationTo',
        type: 'text',
      },
      {
        name: 'categoryID',
        type: 'text',
      },
      {
        name: 'title',
        type: 'text',
      },
    ],
  },
]
