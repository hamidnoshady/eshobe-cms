import type { CollectionConfig } from 'payload'

import { authenticated } from '../../access/authenticated'
import { platformAdminFieldAccess } from '../../access/platformAdmin'

export const Users: CollectionConfig = {
  slug: 'users',
  access: {
    admin: authenticated,
    create: authenticated,
    delete: authenticated,
    // The multi-tenant plugin narrows these to the user's own sites, plus their
    // own user document, via `usersAccessResultOverride`/`withTenantAccess`.
    read: authenticated,
    update: authenticated,
  },
  admin: {
    defaultColumns: ['name', 'email', 'role'],
    useAsTitle: 'name',
  },
  auth: true,
  labels: {
    singular: 'کاربر',
    plural: 'کاربران',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام',
    },
    {
      name: 'role',
      type: 'select',
      label: 'نقش',
      defaultValue: 'user',
      required: true,
      index: true,
      options: [
        { label: 'مدیر پلتفرم', value: 'platformAdmin' },
        { label: 'کاربر', value: 'user' },
      ],
      // Without field-level access any customer who can create or edit a user —
      // which `authenticated` allows — could grant themselves platform admin and
      // read every other customer's content.
      access: {
        create: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      admin: {
        position: 'sidebar',
      },
    },
  ],
  hooks: {
    beforeChange: [
      async ({ data, operation, req }) => {
        if (operation !== 'create') return data

        // Bootstrap: `role` is locked to platform admins, so on a database with no
        // platform admin there is nobody who could grant it. Counting *admins*
        // rather than users matters — counting users promotes whichever account a
        // seed script happens to write first, silently overriding its `role`.
        const { totalDocs } = await req.payload.count({
          collection: 'users',
          req,
          where: { role: { equals: 'platformAdmin' } },
        })

        return totalDocs === 0 ? { ...data, role: 'platformAdmin' } : data
      },
    ],
  },
  timestamps: true,
}
