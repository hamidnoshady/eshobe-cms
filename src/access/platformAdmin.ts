import type { Access, FieldAccess } from 'payload'

import type { User } from '@/payload-types'

/**
 * Platform staff. Sees and edits every site; bypasses the multi-tenant plugin's
 * tenant constraint via `userHasAccessToAllTenants`. Customers never get this.
 */
export const isPlatformAdmin = (user: unknown): boolean =>
  (user as User | null | undefined)?.role === 'platformAdmin'

export const platformAdmin: Access = ({ req: { user } }) => isPlatformAdmin(user)

export const platformAdminFieldAccess: FieldAccess = ({ req: { user } }) => isPlatformAdmin(user)
