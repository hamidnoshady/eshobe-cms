import type { CollectionConfig } from 'payload'

import { link } from '@/fields/link'
import { revalidateSiteGlobal } from '@/hooks/revalidateSiteGlobal'
import { authenticated } from '../access/authenticated'

/**
 * Was a Payload global — see the note on `Header`.
 */
export const Footer: CollectionConfig = {
  slug: 'footer',
  access: {
    create: authenticated,
    delete: authenticated,
    // Public: every page renders the footer. Scoped by `findForSite`.
    read: () => true,
    update: authenticated,
  },
  labels: {
    singular: 'پابرگ',
    plural: 'پابرگ',
  },
  fields: [
    {
      name: 'navItems',
      type: 'array',
      fields: [
        link({
          appearances: false,
        }),
      ],
      maxRows: 6,
      admin: {
        initCollapsed: true,
        components: {
          RowLabel: '@/Footer/RowLabel#RowLabel',
        },
      },
    },
  ],
  hooks: {
    afterChange: [revalidateSiteGlobal('footer')],
  },
}
