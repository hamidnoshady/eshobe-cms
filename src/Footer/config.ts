import type { CollectionConfig } from 'payload'

import { link } from '@/fields/link'
import { revalidateSiteGlobal } from '@/hooks/revalidateSiteGlobal'
import { authenticated } from '../access/authenticated'
import { scopedPublicRead } from '@/access/siteRead'

/**
 * Was a Payload global — see the note on `Header`.
 */
export const Footer: CollectionConfig = {
  slug: 'footer',
  access: {
    create: authenticated,
    delete: authenticated,
    // Public and host-scoped: every page renders the footer (`src/access/siteRead.ts`).
    read: scopedPublicRead(),
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
