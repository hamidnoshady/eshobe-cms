'use client'

import React, { useEffect, useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'

type Overview = {
  configured: boolean
  connection: {
    bucket: string | null
    enabled: boolean
    endpoint: string | null
    healthStatus: string
    id: string
    lastCheckedAt: string | null
    lastHealthyAt: string | null
    latencyMs: number | null
    name: string | null
    provider: string | null
    storageMode: string | null
  } | null
  enabled: boolean
  usable: boolean
}

const healthLabel: Record<string, string> = {
  degraded: 'تضعیف‌شده',
  disabled: 'غیرفعال',
  failed: 'ناموفق',
  healthy: 'سالم',
  retest_required: 'نیاز به آزمون مجدد',
  testing: 'در حال آزمون',
  unknown: 'نامشخص',
}

export const StorageOverviewPanel: React.FC = () => {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/storage-connections/overview', { credentials: 'same-origin' })
        const json = (await res.json()) as Overview & { message?: string }
        if (!res.ok) {
          setError(json.message ?? 'بارگذاری ناموفق')
          return
        }
        setOverview(json)
      } catch {
        setError('ارتباط با سرور برقرار نشد.')
      }
    })()
  }, [])

  if (error) return <div className="banner banner--type-error">{error}</div>
  if (!overview) return <p role="status">در حال بارگذاری…</p>

  const conn = overview.connection
  const status = conn?.healthStatus ?? (overview.enabled ? 'unknown' : 'disabled')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: '48rem' }}>
      <header>
        <h1 style={{ marginBottom: '0.25rem' }}>ذخیره‌سازی اشیا</h1>
        <p style={{ margin: 0 }}>وضعیت اتصال S3-compatible فعال و آخرین خودآزمایی.</p>
      </header>

      <dl style={{ display: 'grid', gap: '0.5rem 1.5rem', gridTemplateColumns: 'max-content 1fr', margin: 0 }}>
        <dt>وضعیت</dt>
        <dd>{healthLabel[status] ?? status}</dd>
        <dt>پیکربندی شده</dt>
        <dd>{overview.configured ? 'بله' : 'خیر'}</dd>
        <dt>اتصال فعال</dt>
        <dd>{overview.enabled ? 'بله' : 'خیر — فایل‌ها روی دیسک محلی'}</dd>
        <dt>قابل استفاده</dt>
        <dd>{overview.usable ? 'بله' : 'خیر'}</dd>
        {conn && (
          <>
            <dt>ارائه‌دهنده</dt>
            <dd>{conn.provider ?? '—'}</dd>
            <dt>باکت</dt>
            <dd>{conn.bucket ?? '—'}</dd>
            <dt>Endpoint</dt>
            <dd style={{ direction: 'ltr', textAlign: 'start' }}>{conn.endpoint ?? '—'}</dd>
            <dt>حالت</dt>
            <dd>{conn.storageMode ?? '—'}</dd>
            <dt>آخرین بررسی</dt>
            <dd>{conn.lastCheckedAt ?? '—'}</dd>
            <dt>تأخیر</dt>
            <dd>{conn.latencyMs != null ? `${conn.latencyMs} ms` : '—'}</dd>
          </>
        )}
      </dl>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <Button
          buttonStyle="secondary"
          el="link"
          to="/admin/collections/storage-connections/infrastructure/storage/health"
        >
          سلامت و diagnostics
        </Button>
        <Button
          buttonStyle="secondary"
          el="link"
          to="/admin/collections/storage-connections/infrastructure/storage/usage"
        >
          مصرف (پایگاه داده)
        </Button>
        <Button buttonStyle="primary" el="link" to="/admin/collections/storage-connections">
          مدیریت اتصالات
        </Button>
      </div>
    </div>
  )
}

export default StorageOverviewPanel
