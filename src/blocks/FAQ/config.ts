import type { Block } from 'payload'

import { sectionIntro } from '../fields'

export const FAQ: Block = {
  slug: 'faq',
  interfaceName: 'FAQBlock',
  fields: [
    ...sectionIntro,
    {
      name: 'items',
      type: 'array',
      label: 'پرسش‌ها',
      labels: { singular: 'پرسش', plural: 'پرسش‌ها' },
      minRows: 1,
      admin: { initCollapsed: true },
      fields: [
        {
          name: 'question',
          type: 'text',
          label: 'پرسش',
          localized: true,
          required: true,
        },
        {
          name: 'answer',
          type: 'textarea',
          label: 'پاسخ',
          localized: true,
          required: true,
        },
      ],
    },
  ],
  labels: {
    singular: 'پرسش‌های پرتکرار',
    plural: 'پرسش‌های پرتکرار',
  },
}
