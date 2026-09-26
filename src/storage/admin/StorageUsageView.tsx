import React from 'react'

import type { AdminViewServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'

import { StorageUsagePanel } from './StorageUsagePanel.client'

export const StorageUsageView: React.FC<AdminViewServerProps> = ({ initPageResult }) => {
  if (!isPlatformAdmin(initPageResult.req.user)) {
    return <div className="banner banner--type-error">فقط کارکنان سکو به این بخش دسترسی دارند.</div>
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>مصرف ذخیره‌سازی</h1>
      <StorageUsagePanel />
    </div>
  )
}

export default StorageUsageView
