import type { Block } from 'payload'

import { sectionIntro } from '../fields'

/**
 * Contact *details*, not a contact form — the form-builder block covers that, and a
 * business site usually wants both.
 *
 * ponytail: no embedded map. An iframe needs a `frame-src` CSP entry and ships the
 * visitor's IP to the map provider on load; add it when a customer asks.
 */
export const Contact: Block = {
  slug: 'contact',
  interfaceName: 'ContactBlock',
  fields: [
    ...sectionIntro,
    {
      name: 'address',
      type: 'textarea',
      label: 'نشانی',
      localized: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'phones',
          type: 'text',
          label: 'شماره تماس',
          hasMany: true,
          admin: {
            description: 'با رقم انگلیسی بنویسید؛ روی سایت فارسی خودکار فارسی می‌شود.',
          },
        },
        {
          name: 'email',
          type: 'email',
          label: 'رایانامه',
        },
      ],
    },
    {
      name: 'hours',
      type: 'textarea',
      label: 'ساعات کاری',
      localized: true,
    },
  ],
  labels: {
    singular: 'اطلاعات تماس',
    plural: 'اطلاعات تماس',
  },
}
