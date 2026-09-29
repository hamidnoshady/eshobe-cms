'use client'

import React, { useEffect, useState } from 'react'

import { Banner, Collapsible } from '@payloadcms/ui'

import type { ReadinessCheck, ThemeReadiness } from '@/deploy/readiness'

/**
 * The top of the deployment console: what is still open before this site's theme can be
 * previewed or published, in the order somebody should do it.
 *
 * It only renders `GET …/deployment/readiness`; every rule lives in
 * `src/deploy/readiness.ts`. Advisory — nothing here disables a button, because the deploy
 * routes keep their own refusals.
 *
 * Open items come first, each with a link to the screen where it is fixed (a page's own
 * editor, opened on the missing language; the site's «تنظیمات پوسته»). What is already
 * done folds away — a list of green ticks is reassurance, not something to read.
 *
 * `refreshKey` changes when the console's deployments do (a deploy started, a build
 * finished), which is exactly when a check such as "no image yet" may have flipped.
 */

const ICON: Record<ReadinessCheck['status'], string> = { blocked: '✕', ok: '✓', warn: '!' }
const OWNER: Record<ReadinessCheck['owner'], string> = {
  customer: 'مشتری',
  operator: 'اپراتور',
}

const CheckItem: React.FC<{ check: ReadinessCheck; settingsHref: string; siteHref: string }> = ({
  check,
  settingsHref,
  siteHref,
}) => {
  const localeCheck = check.id.startsWith('slot-locale:')
  const fallbackHref = check.owner === 'customer' && !check.href ? settingsHref : null
  return (
    <li>
      <span aria-hidden className={`theme-checklist__icon theme-checklist__icon--${check.status}`}>
        {ICON[check.status]}
      </span>
      <span>
        {check.message}{' '}
        <small className="theme-console__muted" style={{ display: 'inline' }}>
          ({OWNER[check.owner]})
        </small>
        {check.status !== 'ok' && (check.href || fallbackHref || localeCheck) && (
          <span className="theme-actions" style={{ display: 'inline-flex', marginInlineStart: '0.5rem' }}>
            {check.href && <a href={check.href}>{localeCheck ? 'باز کردن برای ترجمه' : 'باز کردن'}</a>}
            {fallbackHref && <a href={fallbackHref}>«تنظیمات پوسته»</a>}
            {localeCheck && <a href={siteHref}>«زبان‌ها»ی سایت</a>}
          </span>
        )}
      </span>
    </li>
  )
}

export const ReadinessChecklist: React.FC<{
  refreshKey: string
  settingsHref: string
  siteId: string
}> = ({ refreshKey, settingsHref, siteId }) => {
  const [data, setData] = useState<null | ThemeReadiness>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const response = await fetch(`/api/platform/sites/${siteId}/deployment/readiness`, {
          credentials: 'same-origin',
        })
        const json = (await response.json()) as ThemeReadiness
        if (!alive) return
        if (!response.ok) {
          setFailed(true)
          return
        }
        setFailed(false)
        setData(json)
      } catch {
        if (alive) setFailed(true)
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [siteId, refreshKey])

  // A dead readiness call must not hide the console; the panel has its own error banner.
  if (failed || !data) return null

  const siteHref = `/admin/collections/sites/${siteId}`
  const open = data.checks.filter((check) => check.status !== 'ok')
  const done = data.checks.filter((check) => check.status === 'ok')
  const summary = data.readyForProduction
    ? open.length
      ? 'آمادهٔ انتشار روی دامنه است؛ چند نکته برای بازدیدکننده باقی مانده.'
      : 'همه‌چیز برای انتشار روی دامنه آماده است.'
    : data.readyForPreview
      ? 'پیش‌نمایش آماده است؛ برای انتشار روی دامنه هنوز مواردی باز است.'
      : 'پیش از استقرار مواردی باید کامل شود.'

  return (
    <section className="theme-card">
      <div className="theme-card__head">
        <h2 className="theme-card__title">آمادگی پوسته</h2>
      </div>
      <Banner type={data.readyForProduction ? 'success' : open.some((c) => c.status === 'blocked') ? 'error' : 'info'}>
        {summary}
      </Banner>
      {open.length > 0 && (
        <ul className="theme-checklist">
          {open.map((check) => (
            <CheckItem check={check} key={check.id} settingsHref={settingsHref} siteHref={siteHref} />
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <Collapsible header={`انجام‌شده (${done.length})`} initCollapsed>
          <ul className="theme-checklist">
            {done.map((check) => (
              <CheckItem check={check} key={check.id} settingsHref={settingsHref} siteHref={siteHref} />
            ))}
          </ul>
        </Collapsible>
      )}
    </section>
  )
}
