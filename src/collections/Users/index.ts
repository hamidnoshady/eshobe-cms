import type { CollectionConfig } from 'payload'

import { authenticated } from '../../access/authenticated'
import { platformAdminFieldAccess } from '../../access/platformAdmin'
import { PLATFORM_GROUPS } from '@/admin/visibility'
import { roleForUserCreate } from '@/lib/admin-bootstrap'

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
    // Same reasoning as `sites`: a customer's owner manages their own staff here, and
    // the plugin's `tenants` handling is what keeps that list to their people.
    group: PLATFORM_GROUPS.fleet,
    useAsTitle: 'name',
  },
  /**
   * The session cookie is the whole admin panel — a stolen one is every tenant this
   * user can edit.
   *
   * `secure` is conditional and not simply `true`: a `Secure` cookie is dropped by
   * the browser over plain http, so hardcoding it would break `pnpm dev` on
   * `localhost` with a login that silently never sticks. Production is behind Caddy
   * with TLS, so there it is unconditional.
   *
   * `sameSite: 'Lax'` (Payload's default, restated because it matters) is what stops
   * a third-party page from driving the admin API with the editor's session. Live
   * preview does not need `None` here: the admin and the customer domain are
   * different origins, so the preview handshake hands the token over explicitly and
   * sets its own cookie on the site's domain — see `next/preview/route.ts`.
   */
  auth: {
    cookies: {
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
    },
  },
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

        // Count actual platform admins, not users. In development/test the first-user
        // shortcut keeps local setup convenient. In production it is deliberately
        // disabled: `pnpm bootstrap:admin` proves the one-shot operator token and
        // passes this internal context flag. A public first-user form can therefore
        // never turn its caller into a platform administrator.
        const { totalDocs } = await req.payload.count({
          collection: 'users',
          req,
          where: { role: { equals: 'platformAdmin' } },
        })

        return {
          ...data,
          role: roleForUserCreate({
            bootstrapAuthorized: req.context.platformAdminBootstrap === true,
            isProduction: process.env.NODE_ENV === 'production',
            platformAdminCount: totalDocs,
            requestedRole: data.role,
          }),
        }
      },
    ],
  },
  timestamps: true,
}
