import type { Block } from 'payload'

import {
  FixedToolbarFeature,
  InlineToolbarFeature,
  lexicalEditor,
} from '@payloadcms/richtext-lexical'

export const Banner: Block = {
  slug: 'banner',
  labels: { plural: 'اعلان‌ها', singular: 'اعلان' },
  fields: [
    {
      name: 'style',
      type: 'select',
      label: 'حالت',
      defaultValue: 'info',
      options: [
        { label: 'اطلاع', value: 'info' },
        { label: 'هشدار', value: 'warning' },
        { label: 'خطا', value: 'error' },
        { label: 'موفقیت', value: 'success' },
      ],
      required: true,
    },
    {
      name: 'content',
      type: 'richText',
      editor: lexicalEditor({
        features: ({ rootFeatures }) => {
          return [...rootFeatures, FixedToolbarFeature(), InlineToolbarFeature()]
        },
      }),
      label: false,
      required: true,
    },
  ],
  interfaceName: 'BannerBlock',
}
