import type { Block } from 'payload'

import { sectionIntro } from '../fields'

export const Testimonials: Block = {
  slug: 'testimonials',
  interfaceName: 'TestimonialsBlock',
  fields: [
    ...sectionIntro,
    {
      name: 'items',
      type: 'array',
      label: 'نظرها',
      labels: { singular: 'نظر', plural: 'نظرها' },
      minRows: 1,
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'quote',
          type: 'textarea',
          label: 'متن نظر',
          localized: true,
          required: true,
        },
        {
          type: 'row',
          fields: [
            {
              // Localized: a bilingual site writes "فاطمه احمدی" and "Fatemeh Ahmadi".
              name: 'author',
              type: 'text',
              label: 'نام',
              localized: true,
              required: true,
            },
            {
              name: 'role',
              type: 'text',
              label: 'سمت',
              localized: true,
            },
          ],
        },
        {
          name: 'avatar',
          type: 'upload',
          label: 'تصویر',
          relationTo: 'media',
        },
      ],
    },
  ],
  labels: {
    singular: 'نظر مشتریان',
    plural: 'نظر مشتریان',
  },
}
