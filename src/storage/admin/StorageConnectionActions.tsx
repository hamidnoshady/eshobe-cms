import React from 'react'

import type { UIFieldServerProps } from 'payload'

import { StorageConnectionActionsClient } from './StorageConnectionActionsClient'

export const StorageConnectionActions: React.FC<UIFieldServerProps> = ({ data, id }) => {
  if (!id) {
    return (
      <div className="banner banner--type-default">
        ابتدا اتصال را ذخیره کنید، سپس خودآزمایی را اجرا کنید.
      </div>
    )
  }

  const healthStatus = String((data ?? {}).healthStatus ?? 'unknown')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <StorageConnectionActionsClient connectionId={String(id)} />

      {healthStatus === 'retest_required' && (
        <div className="banner banner--type-warning">
          پیکربندی تغییر کرده است — قبل از فعال‌سازی، خودآزمایی کامل را دوباره اجرا کنید.
        </div>
      )}

      <p style={{ margin: 0, color: 'var(--theme-elevation-600)' }}>
        حذف این رکورد فقط پیکربندی CMS را پاک می‌کند؛ فایل‌های باکت S3 حذف نمی‌شوند.
      </p>
    </div>
  )
}

export default StorageConnectionActions
