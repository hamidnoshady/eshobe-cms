import React from 'react'

import { Button } from '@payloadcms/ui/elements/Button'

import { isPlatformAdmin } from '@/access/platformAdmin'

/**
 * The entry point to issuing a key: a button in the api-keys list header, where
 * "Create New" used to be. Rendered only for platform admins — the collection is
 * invisible to everyone else anyway (`read: platformAdmin`).
 *
 * `to` and not a form: the view it opens (`/admin/collections/api-keys/issue`) owns
 * the form, the same split as the sites collection's `NewSiteButton` → `/provision`.
 */
export const IssueKeyButton: React.FC<{ user?: { role?: string | null } | null }> = ({ user }) => {
  if (!isPlatformAdmin(user)) return null

  return (
    <Button buttonStyle="secondary" el="link" icon="plus" to="/admin/collections/api-keys/issue">
      صدور کلید جدید
    </Button>
  )
}

export default IssueKeyButton
