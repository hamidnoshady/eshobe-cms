import type { Block } from 'payload'

import { columnsField, sectionIntro } from '../fields'

export const Features: Block = {
  slug: 'features',
  interfaceName: 'FeaturesBlock',
  fields: [
    ...sectionIntro,
    columnsField,
    {
      name: 'items',
      type: 'array',
      label: 'ویژگی‌ها',
      labels: { singular: 'ویژگی', plural: 'ویژگی‌ها' },
      minRows: 1,
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'title',
          type: 'text',
          label: 'عنوان',
          localized: true,
          required: true,
        },
        {
          name: 'description',
          type: 'textarea',
          label: 'توضیح',
          localized: true,
        },
        {
          name: 'icon',
          type: 'upload',
          label: 'نشانه',
          relationTo: 'media',
          admin: {
            description: 'تصویر مربعی و کوچک — یک آیکون SVG کافی است.',
          },
        },
      ],
    },
  ],
  labels: {
    singular: 'ویژگی‌ها',
    plural: 'ویژگی‌ها',
  },
}
