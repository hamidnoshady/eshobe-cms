'use client'

import React, { useEffect, useState } from 'react'

import type { ReadinessCheck, ThemeReadiness } from '@/deploy/readiness'

/**
 * The top of the deployment console: what is still open before this site's theme can be
 * previewed or published, in the order somebody should do it.
 *
 * It only renders `GET …/deployment/readiness`; every rule lives in
 * `src/deploy/readiness.ts`. Advisory — nothing here disables a button, because the deploy
 * routes keep their own refusals.
 *
 * `refreshKey` changes when the console's deployments do (a deploy started, a build
 * finished), which is exactly when a check such as "no image yet" may have flipped.
 */

const ICON: Record<ReadinessCheck['status'], string> = { blocked: '✕', ok: '✓', warn: '!' }
const COLOR: Record<ReadinessCheck['status'], string> = {
  blocked: 'var(--theme-error-500)',
  ok: 'var(--theme-success-500)',
  warn: 'var(--theme-warning-500)',
}
const OWNER: Record<ReadinessCheck['owner'], string> = {
  customer: 'مشتری',
  operator: 'اپراتور',
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

  const next = data.nextStep
  const summary = data.readyForProduction
    ? 'همه‌چیز برای انتشار روی دامنه آماده است.'
    : data.readyForPreview
      ? 'پیش‌نمایش آماده است؛ برای انتشار روی دامنه هنوز مواردی باز است.'
      : 'پیش از استقرار مواردی باید کامل شود.'

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <h2 style={{ margin: 0 }}>آمادگی پوسته</h2>
      <div className={`banner banner--type-${data.readyForProduction ? 'success' : 'default'}`}>
        {summary}
        {next && next.status !== 'ok' && (
          <>
            {' '}
            <strong>قدم بعدی ({OWNER[next.owner]}):</strong> {next.message}
            {next.owner === 'customer' && (
              <>
                {' '}
                <a href={settingsHref}>«تنظیمات پوسته»</a>
              </>
            )}
          </>
        )}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data.checks.map((check) => (
          <li key={check.id} style={{ display: 'flex', gap: '0.6rem', padding: '0.15rem 0' }}>
            <span aria-hidden style={{ color: COLOR[check.status], fontWeight: 700, width: '1rem' }}>
              {ICON[check.status]}
            </span>
            <span>
              {check.message}{' '}
              <small style={{ color: 'var(--theme-elevation-500)' }}>({OWNER[check.owner]})</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
