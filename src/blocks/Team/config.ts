import type { Block } from 'payload'

import { columnsField, sectionIntro } from '../fields'

export const Team: Block = {
  slug: 'team',
  interfaceName: 'TeamBlock',
  fields: [
    ...sectionIntro,
    columnsField,
    {
      name: 'members',
      type: 'array',
      label: 'اعضا',
      labels: { singular: 'عضو', plural: 'اعضا' },
      minRows: 1,
      admin: { initCollapsed: true },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'name',
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
          name: 'bio',
          type: 'textarea',
          label: 'معرفی کوتاه',
          localized: true,
        },
        {
          name: 'photo',
          type: 'upload',
          label: 'عکس',
          relationTo: 'media',
        },
      ],
    },
  ],
  labels: {
    singular: 'تیم',
    plural: 'تیم',
  },
}
