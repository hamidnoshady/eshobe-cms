import type { CollectionConfig } from 'payload'

import { link } from '@/fields/link'
import { revalidateSiteGlobal } from '@/hooks/revalidateSiteGlobal'
import { authenticated } from '../access/authenticated'
import { scopedPublicRead } from '@/access/siteRead'
import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'

/**
 * Was a Payload global. Globals are single documents platform-wide and cannot be
 * tenant-scoped, so per-site singletons are collections registered with
 * `isGlobal: true` in the multi-tenant plugin.
 */
export const Header: CollectionConfig = {
  slug: 'header',
  access: {
    create: authenticated,
    delete: authenticated,
    // Public and host-scoped: every page renders the nav (`src/access/siteRead.ts`).
    read: scopedPublicRead(),
    update: authenticated,
  },
  admin: {
    group: SITE_CONTENT_GROUP,
    hidden: hiddenFromOperators,
  },
  labels: {
    singular: 'سربرگ',
    plural: 'سربرگ',
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
          RowLabel: '@/Header/RowLabel#RowLabel',
        },
      },
    },
  ],
  hooks: {
    afterChange: [revalidateSiteGlobal('header')],
  },
}
