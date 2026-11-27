'use client'

/**
 * «جزئیات مهاجرت» — the on-demand replacement for the «منشأ و مهاجرت» group
 * (issue #236).
 *
 * Three things this component deliberately is not:
 *
 * - **Not an editor.** Every value is read-only text, and the provenance
 *   fields are write-protected in the collection config (`source.access`), so
 *   there is no path from here to changing an import's origin.
 * - **Not a second migration screen.** It links to the one Import Manager
 *   (`/admin/migration-center`); the job ledger, retries and reconciliation
 *   live there, not in a document sidebar.
 * - **Not shown for native content.** A `source.system` of `eshobe` (or an
 *   absent group — a document created before provenance existed) renders
 *   nothing, and the field's own `admin.condition` usually stops it mounting.
 *
 * Visibility is a permission decision, not a styling one: platform staff see
 * any site's provenance, a tenant user sees only their own site's. That mirrors
 * `source.rawPayload`'s staff-only read; `rawPayload` itself is never rendered
 * here — the panel shows identifiers, never the source payload.
 */

import React from 'react'

import { useAuth, useConfig, useDocumentInfo, useTranslation } from '@payloadcms/ui'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { formatDate } from '@/lib/format'

type Source = {
  contentHash?: null | string
  installation?: null | string
  mappingStatus?: null | string
  modifiedAt?: null | string
  permalink?: null | string
  sourceAuthorId?: null | string
  sourceId?: null | string
  sourceStatus?: null | string
  sourceType?: null | string
  system?: null | string
}

const SYSTEM_LABELS: Record<string, { en: string; fa: string }> = {
  eshobe: { en: 'Eshobe (native)', fa: 'ای‌شوب (بومی)' },
  other: { en: 'Other system', fa: 'سامانه دیگر' },
  woocommerce: { en: 'WooCommerce', fa: 'ووکامرس' },
  wordpress: { en: 'WordPress', fa: 'وردپرس' },
}

const MAPPING_LABELS: Record<string, { en: string; fa: string }> = {
  archived: { en: 'Archived', fa: 'بایگانی‌شده' },
  blocked: { en: 'Blocked — needs attention', fa: 'مسدود — نیازمند بررسی' },
  imported: { en: 'Imported', fa: 'واردشده' },
  manual: { en: 'Manual', fa: 'دستی' },
}

const idOf = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return ''
}

const siteOf = (user: unknown, siteId: string): boolean => {
  const tenants = (user as null | { tenants?: { tenant?: unknown }[] })?.tenants
  if (!Array.isArray(tenants)) return false
  return tenants.some((row) => idOf(row?.tenant) === siteId)
}

/** Only an ordinary http(s) permalink is turned into a link; anything else is shown as text. */
const safePermalink = (value: null | string | undefined): null | string => {
  if (!value) return null
  return /^https?:\/\//i.test(value) ? value : null
}

const labelOf = (map: Record<string, { en: string; fa: string }>, value: null | string | undefined, en: boolean): string => {
  if (!value) return '—'
  const row = map[value]
  return row ? (en ? row.en : row.fa) : value
}

const wrap: React.CSSProperties = { marginBlock: '1rem' }
const warning: React.CSSProperties = {
  alignItems: 'center',
  background: 'var(--theme-warning-100, var(--theme-elevation-100))',
  border: '1px solid var(--theme-warning-500, var(--theme-elevation-300))',
  borderRadius: 6,
  display: 'flex',
  flexWrap: 'wrap',
  fontSize: '0.85rem',
  gap: '0.5rem',
  marginBlockEnd: '0.5rem',
  padding: '0.6rem 0.75rem',
}
const details: React.CSSProperties = {
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: 6,
  fontSize: '0.85rem',
}
const summary: React.CSSProperties = {
  cursor: 'pointer',
  minHeight: 40,
  padding: '0.6rem 0.75rem',
  textAlign: 'start',
}
const list: React.CSSProperties = {
  display: 'grid',
  gap: '0.35rem 0.75rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  margin: 0,
  padding: '0 0.75rem 0.75rem',
}
const term: React.CSSProperties = { color: 'var(--theme-elevation-600)', fontSize: '0.75rem' }
const value: React.CSSProperties = { margin: 0, overflowWrap: 'anywhere' }
const note: React.CSSProperties = {
  borderBlockStart: '1px solid var(--theme-elevation-100)',
  color: 'var(--theme-elevation-600)',
  fontSize: '0.75rem',
  margin: 0,
  padding: '0.6rem 0.75rem',
}

export const MigrationDetails: React.FC = () => {
  const { user } = useAuth()
  const { config } = useConfig()
  const { data } = useDocumentInfo() as { data?: Record<string, unknown> }
  const { i18n } = useTranslation()

  const english = i18n?.language === 'en'
  const t = (fa: string, en: string) => (english ? en : fa)
  const locale = english ? 'en' : 'fa'

  const source = (data?.source ?? null) as null | Source
  const system = typeof source?.system === 'string' ? source.system : null

  // Native (or pre-provenance) records have nothing to explain.
  if (!source || !system || system === 'eshobe') return null

  const siteId = idOf(data?.site)
  const permitted = Boolean(user) && (isPlatformAdmin(user) || (siteId !== '' && siteOf(user, siteId)))
  if (!permitted) return null

  const adminRoute = config?.routes?.admin ?? '/admin'
  const importsHref = `${adminRoute === '/' ? '' : adminRoute.replace(/\/$/, '')}/migration-center`
  const blocked = source.mappingStatus === 'blocked'
  const permalink = safePermalink(source.permalink)

  const rows: { label: string; node: React.ReactNode }[] = [
    { label: t('سامانه مبدأ', 'Source system'), node: labelOf(SYSTEM_LABELS, system, english) },
    { label: t('وضعیت نگاشت', 'Mapping status'), node: labelOf(MAPPING_LABELS, source.mappingStatus, english) },
    { label: t('نصب مبدأ', 'Source installation'), node: source.installation || '—' },
    { label: t('شناسه در مبدأ', 'Source record ID'), node: source.sourceId || '—' },
    {
      label: t('گونه و وضعیت در مبدأ', 'Source type & status'),
      node: [source.sourceType, source.sourceStatus].filter(Boolean).join(' · ') || '—',
    },
    { label: t('شناسه نویسنده در مبدأ', 'Source author ID'), node: source.sourceAuthorId || '—' },
    {
      label: t('آخرین ویرایش در مبدأ', 'Last modified at source'),
      node: source.modifiedAt ? formatDate(source.modifiedAt, locale) : '—',
    },
    {
      label: t('پیوسته‌نشانی مبدأ', 'Source permalink'),
      node: permalink ? (
        <a href={permalink} rel="noreferrer noopener" target="_blank">
          {permalink}
        </a>
      ) : (
        source.permalink || '—'
      ),
    },
  ]

  return (
    <div style={wrap}>
      {blocked ? (
        <div role="status" style={warning}>
          <span>
            {t(
              'این رکورد در درون‌ریزی حل‌نشده مانده است؛ تا رفع خطا، تغییرهای عادی آن را کامل نمی‌کنند.',
              'This record has an unresolved import conflict. Ordinary edits do not resolve it.',
            )}
          </span>
          <a href={importsHref}>{t('بررسی در درون‌ریزی', 'Review in Imports')}</a>
        </div>
      ) : null}

      <details style={details}>
        <summary style={summary}>{t('جزئیات مهاجرت', 'Migration details')}</summary>
        <dl style={list}>
          {rows.map((row) => (
            <div key={row.label}>
              <dt style={term}>{row.label}</dt>
              <dd style={value}>{row.node}</dd>
            </div>
          ))}
        </dl>
        <p style={note}>
          {t(
            'این اطلاعات فقط‌خواندنی است و با ذخیرهٔ عادی سند تغییر نمی‌کند. مدیریت کارها، خطاها و هم‌گام‌سازی در «ابزارها → درون‌ریزی» است.',
            'Read-only; an ordinary save never changes it. Jobs, errors and sync are managed in Tools → Imports.',
          )}{' '}
          <a href={importsHref}>{t('درون‌ریزی', 'Imports')}</a>
        </p>
      </details>
    </div>
  )
}

export default MigrationDetails
