import React from 'react'

import { Button } from '@payloadcms/ui/elements/Button'

import { isPlatformAdmin } from '@/access/platformAdmin'

export const StorageNavButton: React.FC<{ user?: { role?: string | null } | null }> = ({ user }) => {
  if (!isPlatformAdmin(user)) return null

  return (
    <Button
      buttonStyle="secondary"
      el="link"
      to="/admin/collections/storage-connections/infrastructure/storage"
    >
      نمای کلی ذخیره‌سازی
    </Button>
  )
}

export default StorageNavButton
