import type { Block } from 'payload'

import { sectionIntro } from '../fields'

export const Logos: Block = {
  slug: 'logos',
  interfaceName: 'LogosBlock',
  fields: [
    ...sectionIntro,
    {
      name: 'logos',
      type: 'upload',
      label: 'نشان‌ها',
      hasMany: true,
      relationTo: 'media',
      required: true,
      admin: {
        description: 'نشان مشتریان یا همکاران. برای هر تصویر، متن جانشین را در رسانه بنویسید.',
      },
    },
  ],
  labels: {
    singular: 'نشان مشتریان',
    plural: 'نشان مشتریان',
  },
}
