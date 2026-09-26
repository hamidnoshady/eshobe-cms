import React from 'react'

import type { AdminViewServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'

import { StorageOverviewPanel } from './StorageOverviewPanel.client'

export const StorageOverviewView: React.FC<AdminViewServerProps> = ({ initPageResult }) => {
  if (!isPlatformAdmin(initPageResult.req.user)) {
    return <div className="banner banner--type-error">فقط کارکنان سکو به این بخش دسترسی دارند.</div>
  }

  return (
    <div style={{ padding: '2rem' }}>
      <StorageOverviewPanel />
    </div>
  )
}

export default StorageOverviewView
