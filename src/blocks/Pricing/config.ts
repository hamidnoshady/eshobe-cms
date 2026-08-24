import type { Block } from 'payload'

import { link } from '@/fields/link'

import { sectionIntro } from '../fields'

export const Pricing: Block = {
  slug: 'pricing',
  interfaceName: 'PricingBlock',
  fields: [
    ...sectionIntro,
    {
      name: 'plans',
      type: 'array',
      label: 'طرح‌ها',
      labels: { singular: 'طرح', plural: 'طرح‌ها' },
      minRows: 1,
      maxRows: 4,
      admin: { initCollapsed: true },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'name',
              type: 'text',
              label: 'نام طرح',
              localized: true,
              required: true,
            },
            {
              name: 'featured',
              type: 'checkbox',
              label: 'طرح پیشنهادی',
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'price',
              type: 'number',
              label: 'مبلغ',
              min: 0,
              admin: {
                description: 'فقط عدد. رقم‌ها روی سایت فارسی خودکار فارسی می‌شوند.',
              },
            },
            {
              // The editor names the unit, so the platform never has to guess Toman
              // vs Rial — an order-of-magnitude mistake if it guesses wrong.
              name: 'unit',
              type: 'text',
              label: 'واحد',
              defaultValue: 'تومان',
              localized: true,
            },
            {
              name: 'period',
              type: 'text',
              label: 'دوره',
              localized: true,
              admin: { placeholder: 'ماهانه' },
            },
          ],
        },
        {
          // `hasMany` on a text field — Payload's own repeater UI, no nested array
          // with a single field in it.
          name: 'features',
          type: 'text',
          label: 'امکانات',
          hasMany: true,
          localized: true,
        },
        {
          name: 'enableLink',
          type: 'checkbox',
          label: 'دکمهٔ خرید',
        },
        // Same shape as the Content block's optional link: `link()` requires a label
        // and a target, and a field hidden by `condition` is not validated.
        link({
          appearances: false,
          overrides: {
            admin: { condition: (_data, siblingData) => Boolean(siblingData?.enableLink) },
          },
        }),
      ],
    },
  ],
  labels: {
    singular: 'تعرفه‌ها',
    plural: 'تعرفه‌ها',
  },
}
