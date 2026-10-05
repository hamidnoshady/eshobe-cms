import type { Block, Field } from 'payload'

import {
  BlocksFeature,
  FixedToolbarFeature,
  HeadingFeature,
  InlineToolbarFeature,
  lexicalEditor,
} from '@payloadcms/richtext-lexical'

import { MediaBlockInline } from '@/blocks/MediaBlock/config'
import { link } from '@/fields/link'

const columnFields: Field[] = [
  {
    name: 'size',
    type: 'select',
    label: 'پهنای ستون',
    defaultValue: 'oneThird',
    admin: {
      description: 'ستون‌ها روی یک شبکهٔ ۱۲ستونه کنار هم می‌نشینند و در موبایل زیر هم می‌روند.',
    },
    options: [
      { label: 'یک‌چهارم', value: 'oneQuarter' },
      { label: 'یک‌سوم', value: 'oneThird' },
      { label: 'نصف', value: 'half' },
      { label: 'دوسوم', value: 'twoThirds' },
      { label: 'سه‌چهارم', value: 'threeQuarters' },
      { label: 'تمام عرض', value: 'full' },
    ],
  },
  {
    name: 'richText',
    type: 'richText',
    editor: lexicalEditor({
      features: ({ rootFeatures }) => {
        return [
          ...rootFeatures,
          HeadingFeature({ enabledHeadingSizes: ['h2', 'h3', 'h4'] }),
          // An image in a column is what makes «text beside a photo» buildable.
          BlocksFeature({ blocks: [MediaBlockInline] }),
          FixedToolbarFeature(),
          InlineToolbarFeature(),
        ]
      },
    }),
    label: false,
    localized: true,
  },
  {
    name: 'enableLink',
    type: 'checkbox',
    label: 'افزودن پیوند',
  },
  link({
    overrides: {
      admin: {
        condition: (_data, siblingData) => {
          return Boolean(siblingData?.enableLink)
        },
      },
    },
  }),
]

export const Content: Block = {
  slug: 'content',
  interfaceName: 'ContentBlock',
  labels: { plural: 'متن‌های ستونی', singular: 'متن ستونی' },
  fields: [
    {
      name: 'columns',
      type: 'array',
      label: 'ستون‌ها',
      labels: { plural: 'ستون‌ها', singular: 'ستون' },
      admin: {
        initCollapsed: true,
      },
      fields: columnFields,
    },
  ],
}
