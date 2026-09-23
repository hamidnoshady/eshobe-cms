import React from 'react'

import type { UIFieldServerProps } from 'payload'

import { ActionButton } from './ActionButton'

/**
 * The sync/publish panel on a `theme-packages` document.
 *
 * A server component, so it reads the saved document rather than the form: both
 * actions are about what is *stored*, and offering "publish" against unsaved edits
 * would publish something other than what the operator is looking at.
 *
 * ## Why these are buttons and not fields
 *
 * The manifest-derived fields (build commands, port, env schema, site types) are
 * read-only in the form, because the repository is what has to build. Sync is the only
 * writer. Publishing is a separate, deliberate second step — registering code to run on
 * the operator's own servers for real customers is not something that should happen as
 * a side effect of saving a form.
 */
export const ThemePackageActions: React.FC<UIFieldServerProps> = ({ data, id }) => {
  if (!id) {
    return (
      <div className="banner banner--type-default">
        ابتدا مخزن و شاخه را ذخیره کنید، سپس «همگام‌سازی از گیت‌هاب» را اجرا کنید.
      </div>
    )
  }

  const doc = (data ?? {}) as Record<string, unknown>
  const status = String(doc.status ?? 'draft')
  const syncedAt = doc.manifestSyncedAt ? String(doc.manifestSyncedAt) : null
  const syncError = doc.syncError ? String(doc.syncError) : null

  const base = `/api/platform/theme-packages/${String(id)}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
        <ActionButton
          label="همگام‌سازی از گیت‌هاب"
          successMessage="مانیفست خوانده شد."
          url={`${base}/sync`}
        />

        <ActionButton
          /**
           * Publishing is gated on a successful sync, and the button says so rather
           * than failing on click. The endpoint refuses it anyway — this is the same
           * rule stated twice, in the place where each audience meets it.
           */
          disabled={!syncedAt}
          label={status === 'published' ? 'منتشر شده ✓' : 'انتشار برای مشتریان'}
          style="primary"
          successMessage="پوسته منتشر شد و در فهرست انتخاب مشتریان دیده می‌شود."
          url={`${base}/publish`}
        />
      </div>

      {!syncedAt && (
        <div className="banner banner--type-default">
          این پوسته هنوز همگام‌سازی نشده است. تا وقتی مانیفست (<code dir="ltr">eshobe.theme.json</code>)
          با موفقیت خوانده نشود، امکان انتشار و استقرار وجود ندارد.
        </div>
      )}

      {syncError && (
        <div className="banner banner--type-error">
          آخرین همگام‌سازی ناموفق بود: {syncError}
          <br />
          مانیفست قبلی دست‌نخورده باقی مانده است، بنابراین استقرارهای فعلی متوقف نمی‌شوند.
        </div>
      )}

      {status === 'published' && (
        <div className="banner banner--type-success">
          این پوسته منتشر شده است. برای برداشتن آن از فهرست انتخاب، وضعیت را به «منسوخ» تغییر دهید —
          استقرارهای فعلی با این کار متوقف نمی‌شوند.
        </div>
      )}
    </div>
  )
}

export default ThemePackageActions
