import React from 'react'

import type { AdminViewServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'

import { StorageOverviewPanel } from './StorageOverviewPanel.client'

/** Health-focused page — reuses overview data; detailed per-connection health lives on each document. */
export const StorageHealthView: React.FC<AdminViewServerProps> = ({ initPageResult }) => {
  if (!isPlatformAdmin(initPageResult.req.user)) {
    return <div className="banner banner--type-error">فقط کارکنان سکو به این بخش دسترسی دارند.</div>
  }

  return (
    <div style={{ padding: '2rem' }}>
      <h1>سلامت ذخیره‌سازی</h1>
      <p>برای جزئیات هر اتصال (نوشتن/خواندن/حذف)، خودآزمایی کامل را روی همان سند اجرا کنید.</p>
      <StorageOverviewPanel />
    </div>
  )
}

export default StorageHealthView
