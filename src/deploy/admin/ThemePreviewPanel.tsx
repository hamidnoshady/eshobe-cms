'use client'

import React, { useState } from 'react'

import { Banner } from '@payloadcms/ui'

/**
 * A viewport switcher over the site's **already-deployed** theme.
 *
 * It is deliberately not a live preview of unsaved values. Rendering a draft would
 * mean posting the customer's working values somewhere they are not stored yet, and
 * the only existing signed preview path writes a descriptor — the wrong tool for "look
 * at a heading". The typography sample is the unsaved preview; this frame is the
 * honest saved one, labelled as such, sandboxed and without the admin's referrer.
 *
 * The admin session is never handed to the frame: it is a plain cross-origin iframe
 * with `referrerPolicy="no-referrer"` and no credentials bootstrap.
 */

export const PREVIEW_WIDTHS = [375, 768, 1440] as const
export type PreviewWidth = (typeof PREVIEW_WIDTHS)[number]

export type ThemePreviewPanelProps = {
  english: boolean
  previewUrl: null | string
}

export const ThemePreviewPanel: React.FC<ThemePreviewPanelProps> = ({ english, previewUrl }) => {
  const [width, setWidth] = useState<PreviewWidth>(1440)
  const [loaded, setLoaded] = useState(false)

  if (!previewUrl) {
    return (
      <section className="theme-card">
        <div className="theme-card__head">
          <h2 className="theme-card__title">{english ? 'Site preview' : 'پیش‌نمایش سایت'}</h2>
        </div>
        <Banner type="info">
          {english
            ? 'There is no deployed preview for this theme yet. The live sample above still shows the resolved px values; deploy the theme to preview the whole site.'
            : 'هنوز نسخهٔ مستقرشده‌ای از این پوسته برای پیش‌نمایش وجود ندارد. نمونهٔ زندهٔ بالا مقدار نهایی پیکسل را نشان می‌دهد؛ برای دیدن کل سایت، پوسته را مستقر کنید.'}
        </Banner>
      </section>
    )
  }

  return (
    <section className="theme-card theme-preview">
      <div className="theme-card__head">
        <h2 className="theme-card__title">{english ? 'Site preview' : 'پیش‌نمایش سایت'}</h2>
        <div className="theme-preview__widths" role="group" aria-label={english ? 'Viewport width' : 'عرض نما'}>
          {PREVIEW_WIDTHS.map((candidate) => (
            <button
              aria-pressed={width === candidate}
              className="theme-tab theme-tab--small"
              key={candidate}
              onClick={() => {
                setWidth(candidate)
                setLoaded(false)
              }}
              type="button"
            >
              {candidate}px
            </button>
          ))}
        </div>
      </div>

      <p className="theme-console__muted">
        {english
          ? 'This frame shows the saved, already-deployed build. Unsaved changes are not applied here — use the live typography sample for those.'
          : 'این قاب نسخهٔ ذخیره‌شده و مستقرشده را نشان می‌دهد. تغییرات ذخیره‌نشده این‌جا اعمال نمی‌شوند؛ برای آن‌ها از نمونهٔ زندهٔ تایپوگرافی استفاده کنید.'}
      </p>

      <div className="theme-preview__frame-wrap">
        {!loaded && (
          <span className="theme-preview__loading" role="status">
            {english ? 'Loading the saved site…' : 'در حال بارگذاری نسخهٔ ذخیره‌شده…'}
          </span>
        )}
        <iframe
          className="theme-preview__frame"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          referrerPolicy="no-referrer"
          sandbox="allow-forms allow-scripts allow-same-origin"
          src={previewUrl}
          style={{ maxWidth: '100%', width: `${width}px` }}
          title={english ? 'Saved site preview' : 'پیش‌نمایش نسخهٔ ذخیره‌شدهٔ سایت'}
        />
      </div>

      <a
        className="theme-console__muted"
        href={previewUrl}
        rel="noreferrer noopener"
        target="_blank"
      >
        {english ? 'Open the saved preview in a new tab' : 'باز کردن پیش‌نمایش ذخیره‌شده در زبانهٔ تازه'}
      </a>
    </section>
  )
}

export default ThemePreviewPanel
