import React from 'react'

import { Button } from '@payloadcms/ui/elements/Button'

import { isPlatformAdmin } from '@/access/platformAdmin'

/**
 * The entry point to the "New site" action: a button in the Sites list header,
 * next to "Create New". Rendered only for platform admins — creating sites is
 * the agency's job, and a client's owner sees the list to *read* their site.
 */
export const NewSiteButton: React.FC<{ user?: { role?: string | null } | null }> = ({ user }) => {
  if (!isPlatformAdmin(user)) return null

  return (
    <Button buttonStyle="secondary" el="link" icon="plus" to="/admin/collections/sites/provision">
      ساخت سایت جدید
    </Button>
  )
}

export default NewSiteButton
