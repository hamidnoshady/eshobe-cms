'use client'

import React, { useEffect, useState } from 'react'

import { formatNumber } from '@/lib/format'

type Usage = {
  bySite: { bytesKnown: number; items: number; siteId: string }[]
  databaseBytesKnown: number
  databaseBytesUnknownCount: number
  lastUploadAt: string | null
  mediaItems: number
}

export const StorageUsagePanel: React.FC = () => {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/storage-connections/usage', { credentials: 'same-origin' })
        const json = (await res.json()) as { message?: string; usage?: Usage }
        if (!res.ok) {
          setError(json.message ?? 'بارگذاری ناموفق')
          return
        }
        setUsage(json.usage ?? null)
      } catch {
        setError('ارتباط با سرور برقرار نشد.')
      }
    })()
  }, [])

  if (error) return <div className="banner banner--type-error">{error}</div>
  if (!usage) return <p role="status">در حال بارگذاری…</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '56rem' }}>
      <p>
        اعداد زیر از جدول <code>media</code> در Postgres هستند — نه گزارش مصرف باکت S3 از side
        provider.
      </p>
      <dl style={{ display: 'grid', gap: '0.35rem 1rem', gridTemplateColumns: 'max-content 1fr', margin: 0 }}>
        <dt>تعداد رسانه</dt>
        <dd>{formatNumber(usage.mediaItems, 'fa')}</dd>
        <dt>حجم شناخته‌شده (bytes)</dt>
        <dd>{formatNumber(usage.databaseBytesKnown, 'fa')}</dd>
        <dt>بدون filesize</dt>
        <dd>{formatNumber(usage.databaseBytesUnknownCount, 'fa')}</dd>
        <dt>آخرین آپلود</dt>
        <dd>{usage.lastUploadAt ?? '—'}</dd>
      </dl>

      <h2>به تفکیک سایت (prefix)</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'start' }}>Site ID</th>
            <th style={{ textAlign: 'start' }}>Items</th>
            <th style={{ textAlign: 'start' }}>Bytes known</th>
          </tr>
        </thead>
        <tbody>
          {usage.bySite.map((row) => (
            <tr key={row.siteId}>
              <td style={{ direction: 'ltr' }}>{row.siteId}</td>
              <td>{formatNumber(row.items, 'fa')}</td>
              <td>{formatNumber(row.bytesKnown, 'fa')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default StorageUsagePanel
