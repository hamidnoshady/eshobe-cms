'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'
import { SelectInput } from '@payloadcms/ui/fields/Select'

import { formatDate } from '@/lib/format'

import { ActionButton } from './ActionButton'

/**
 * The per-site deployment console: `/admin/collections/sites/:id/deployment`.
 *
 * One screen answering the three questions an operator actually has — what is serving
 * this site, what can I put on it, and how do I get back — plus the history that makes
 * a rollback possible.
 *
 * ## Why it polls
 *
 * A deploy is a queued job that takes minutes. The create call answers `202` and
 * returns immediately; without polling the operator is left looking at "در صف" with no
 * way to tell a slow build from a dead one except reloading by hand. The interval is
 * deliberately conservative — every tick is a Coolify API call on the operator's own
 * rate limit — and **stops as soon as nothing is pending**, so an idle console costs
 * nothing.
 *
 * `POST .../poll` is what advances a build: it asks Coolify for the deployment's real
 * state and moves the row forward. So this is not a passive refresh, which is exactly
 * why it must not run unattended in a loop forever.
 */

type Deployment = {
  commitSha: null | string
  createdAt: null | string
  deployedAt: null | string
  domain: null | string
  domainMode: string
  id: string
  lastError: null | string
  logTail: null | string
  previewDomain: null | string
  ref: null | string
  status: string
  themePackage: null | string
}

type ThemePackage = {
  id: string
  key: string
  name: string
  proxiesApi: boolean
  repository: null | string
  siteTypes: string[]
  status: string
}

type Option = { label: string; value: string }

const STATUS_LABELS: Record<string, string> = {
  building: 'در حال ساخت',
  creating: 'در حال ایجاد',
  failed: 'ناموفق',
  live: 'در حال سرویس‌دهی',
  queued: 'در صف',
  removed: 'حذف‌شده',
  stopped: 'متوقف',
  verifying: 'در حال بررسی سلامت',
}

const MODE_LABELS: Record<string, string> = {
  direct: 'دامنه مستقیم روی Coolify',
  edge: 'دامنه روی Caddy، پراکسی به پوسته',
  preview: 'فقط زیردامنهٔ پیش‌نمایش',
}

/** Mirrors `isPending` in `src/lib/deploy/status.ts` — the states still expecting work. */
const PENDING = new Set(['queued', 'creating', 'building', 'verifying'])

const POLL_MS = 5000

const bannerFor = (status: string): string => {
  if (status === 'live') return 'success'
  if (status === 'failed') return 'error'
  return 'default'
}

const shortSha = (sha: null | string): string => (sha ? sha.slice(0, 8) : '—')

/**
 * Jalali, via the house helper rather than a bare `Intl` call.
 *
 * A build log read by an Iranian operator showing "September 22, 2026" is the exact
 * failure the repo's `no-restricted-syntax` rule exists to prevent — and a deployment
 * timeline is precisely where a misread date costs something.
 */
const formatWhen = (value: null | string): string => {
  if (!value) return '—'
  return formatDate(value, 'fa', { dateStyle: 'medium', timeStyle: 'short' }) || value
}

export type DeploymentPanelProps = {
  siteDomain: string
  siteId: string
  siteName: string
  siteType: string
  /** Gates the modes offered: an unverified domain may only ever get a preview. */
  domainVerified: boolean
}

export const DeploymentPanel: React.FC<DeploymentPanelProps> = ({
  domainVerified,
  siteDomain,
  siteId,
  siteName,
  siteType,
}) => {
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [renderedBy, setRenderedBy] = useState<string>('platform')
  const [packages, setPackages] = useState<ThemePackage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<null | string>(null)

  const [packageKey, setPackageKey] = useState('')
  const [domainMode, setDomainMode] = useState('preview')

  // A ref, not state: the polling effect reads it without wanting to re-subscribe.
  const pollingRef = useRef(false)

  const base = `/api/platform/sites/${siteId}/deployment`

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { credentials: 'same-origin' })
      const json = (await response.json()) as {
        deployments?: Deployment[]
        message?: string
        renderedBy?: string
      }

      if (!response.ok) {
        setError(json.message ?? 'وضعیت استقرار خوانده نشد.')
        return
      }

      setError(null)
      setDeployments(json.deployments ?? [])
      setRenderedBy(json.renderedBy ?? 'platform')
    } catch {
      setError('ارتباط با سرور برقرار نشد.')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
    /**
     * Wrapped in an async closure rather than a bare `void load()`: the state writes
     * then land after an await instead of synchronously inside the effect body, which
     * is both what `react-hooks/set-state-in-effect` asks for and the same shape the
     * package-loading effect below already uses.
     */
    const run = async () => {
      await load()
    }

    void run()
  }, [load])

  useEffect(() => {
    let alive = true

    const loadPackages = async () => {
      try {
        const response = await fetch('/api/platform/theme-packages', { credentials: 'same-origin' })
        const json = (await response.json()) as { packages?: ThemePackage[] }
        if (alive && response.ok) setPackages(json.packages ?? [])
      } catch {
        /* The banner from `load` already covers a dead connection. */
      }
    }

    void loadPackages()
    return () => {
      alive = false
    }
  }, [])

  const pending = deployments.filter((row) => PENDING.has(row.status))

  /**
   * Poll only while something is actually in flight, and never overlap two requests:
   * each tick drives a Coolify call, and a slow one must not queue up behind itself.
   */
  useEffect(() => {
    if (pending.length === 0) return

    const id = window.setInterval(() => {
      if (pollingRef.current) return
      pollingRef.current = true

      void (async () => {
        try {
          await fetch(`${base}/poll`, {
            body: JSON.stringify({ deployment: pending[0].id }),
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          })
          await load()
        } catch {
          /* Transient; the next tick retries. */
        } finally {
          pollingRef.current = false
        }
      })()
    }, POLL_MS)

    return () => window.clearInterval(id)
  }, [base, load, pending])

  const current = deployments.find((row) => row.status === 'live') ?? null

  /**
   * Only published packages, and only those that declare this site's type. The server
   * refuses the rest — offering them here would just be a menu of ways to get an
   * error, and an operator cannot tell "not for this site" from "broken" from a 409.
   */
  const eligible = packages.filter(
    (pkg) => pkg.status === 'published' && pkg.siteTypes.includes(siteType),
  )

  const selected = eligible.find((pkg) => pkg.key === packageKey) ?? null

  const modeOptions: Option[] = [
    { label: MODE_LABELS.preview, value: 'preview' },
    { label: MODE_LABELS.edge, value: 'edge' },
    { label: MODE_LABELS.direct, value: 'direct' },
  ]

  const modeBlocked = ((): null | string => {
    if (domainMode === 'preview') return null
    if (!domainVerified) {
      return `دامنهٔ «${siteDomain}» هنوز تأیید نشده است. تا پیش از تأیید، فقط حالت پیش‌نمایش ممکن است.`
    }
    if (domainMode === 'direct' && selected && !selected.proxiesApi) {
      return 'این پوسته اعلام نکرده که درخواست‌های /api را پراکسی می‌کند. در حالت «دامنه مستقیم»، پرداخت و فرم‌ها از کار می‌افتند.'
    }
    return null
  })()

  if (loading) return <p>در حال بارگذاری…</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', maxWidth: '60rem' }}>
      <div>
        <h1>استقرار پوسته — {siteName}</h1>
        <p style={{ color: 'var(--theme-elevation-600)' }}>
          دامنه: <code dir="ltr">{siteDomain}</code>
          {!domainVerified && ' (تأیید نشده)'}
        </p>
      </div>

      {error && <div className="banner banner--type-error">{error}</div>}

      {/* ---------------------------------------------------------------- */}
      {/* What is serving right now */}
      {/* ---------------------------------------------------------------- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>اکنون چه چیزی سرویس می‌دهد؟</h2>

        {renderedBy === 'platform' || !current ? (
          <div className="banner banner--type-default">
            این سایت با رندرکنندهٔ داخلی سرویس داده می‌شود (حالت پیش‌فرض). هیچ پوستهٔ بیرونی روی آن
            فعال نیست.
          </div>
        ) : (
          <div className="banner banner--type-success">
            پوستهٔ بیرونی روی <code dir="ltr">{current.domain}</code> فعال است —{' '}
            {MODE_LABELS[current.domainMode] ?? current.domainMode}، کامیت{' '}
            <code dir="ltr">{shortSha(current.commitSha)}</code>.
          </div>
        )}

        {current && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
            <ActionButton
              body={{ deployment: current.id }}
              confirm="این استقرار متوقف می‌شود و سایت به رندرکنندهٔ داخلی برمی‌گردد. ادامه می‌دهید؟"
              label="توقف این استقرار"
              style="danger"
              url={`${base}/stop`}
            />

            <ActionButton
              confirm="سایت به رندرکنندهٔ داخلی برمی‌گردد و همهٔ استقرارهای فعال آن متوقف می‌شوند. ادامه می‌دهید؟"
              label="بازگشت به رندرکنندهٔ داخلی"
              style="danger"
              successMessage="سایت به رندرکنندهٔ داخلی بازگشت."
              url={`${base}/revert`}
            />
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Deploy something new */}
      {/* ---------------------------------------------------------------- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>استقرار پوستهٔ جدید</h2>

        {eligible.length === 0 ? (
          <div className="banner banner--type-default">
            هیچ پوستهٔ منتشرشده‌ای برای سایت از نوع «{siteType}» وجود ندارد. ابتدا در بخش «پوسته‌های
            قابل استقرار» یک پوسته را همگام‌سازی و منتشر کنید.
          </div>
        ) : (
          <>
            <SelectInput
              label="پوسته"
              name="package"
              onChange={(option) => setPackageKey(String((option as Option)?.value ?? ''))}
              options={eligible.map((pkg) => ({
                label: `${pkg.name} (${pkg.key})`,
                value: pkg.key,
              }))}
              path="package"
              value={packageKey}
            />

            <SelectInput
              description="حالت پیش‌نمایش هیچ تغییری در DNS مشتری نمی‌دهد و برای آزمایش امن است."
              label="حالت دامنه"
              name="domainMode"
              onChange={(option) => setDomainMode(String((option as Option)?.value ?? 'preview'))}
              options={modeOptions}
              path="domainMode"
              value={domainMode}
            />

            {modeBlocked && <div className="banner banner--type-error">{modeBlocked}</div>}

            {domainMode === 'direct' && !modeBlocked && (
              <div className="banner banner--type-default">
                در این حالت DNS مشتری مستقیماً به Coolify اشاره می‌کند و دیگر از Caddy عبور نمی‌کند.
                پرداخت، فرم‌ها و رسانه فقط در صورتی کار می‌کنند که خود پوسته آن‌ها را پراکسی کند.
              </div>
            )}

            <ActionButton
              body={{ domainMode, package: packageKey }}
              disabled={!packageKey || Boolean(modeBlocked)}
              label="شروع استقرار"
              style="primary"
              successMessage="استقرار در صف قرار گرفت. وضعیت آن در همین صفحه به‌روز می‌شود."
              url={base}
            />
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* History */}
      {/* ---------------------------------------------------------------- */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <h2 style={{ margin: 0 }}>تاریخچهٔ استقرارها</h2>

        {pending.length > 0 && (
          <div className="banner banner--type-default">
            {pending.length} استقرار در جریان است. این صفحه هر {POLL_MS / 1000} ثانیه به‌روز می‌شود.
          </div>
        )}

        {deployments.length === 0 ? (
          <p>هنوز هیچ استقراری برای این سایت انجام نشده است.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {deployments.map((row) => (
              <div
                key={row.id}
                style={{
                  backgroundColor: 'var(--theme-elevation-50)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  padding: '1rem',
                }}
              >
                <div className={`banner banner--type-${bannerFor(row.status)}`} style={{ margin: 0 }}>
                  {STATUS_LABELS[row.status] ?? row.status} — <code dir="ltr">{row.domain ?? '—'}</code>{' '}
                  ({MODE_LABELS[row.domainMode] ?? row.domainMode})
                </div>

                <div style={{ color: 'var(--theme-elevation-600)', fontSize: '0.85rem' }}>
                  کامیت <code dir="ltr">{shortSha(row.commitSha)}</code>
                  {row.ref ? (
                    <>
                      {' '}
                      از <code dir="ltr">{row.ref}</code>
                    </>
                  ) : null}
                  {' — ساخته‌شده: '}
                  {formatWhen(row.createdAt)}
                  {row.deployedAt ? ` — فعال‌شده: ${formatWhen(row.deployedAt)}` : ''}
                </div>

                {row.lastError && (
                  <div className="banner banner--type-error" style={{ margin: 0 }}>
                    {row.lastError}
                  </div>
                )}

                {row.logTail && (
                  <details>
                    <summary>گزارش ساخت</summary>
                    <pre
                      dir="ltr"
                      style={{
                        backgroundColor: 'var(--theme-elevation-100)',
                        fontSize: '0.8rem',
                        maxHeight: '18rem',
                        overflow: 'auto',
                        padding: '0.75rem',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {row.logTail}
                    </pre>
                  </details>
                )}

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                  {PENDING.has(row.status) && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      label="بررسی وضعیت"
                      url={`${base}/poll`}
                    />
                  )}

                  {row.status === 'verifying' && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      label="بررسی سلامت و فعال‌سازی"
                      url={`${base}/verify`}
                    />
                  )}

                  {/*
                   * A rollback is offered from any row that recorded a commit and is
                   * not the one already serving. It does not mutate the running
                   * application — it creates a new deployment pinned to that commit,
                   * so the history stays a history.
                   */}
                  {row.commitSha && row.status !== 'live' && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      confirm={`یک استقرار تازه با کامیت ${shortSha(row.commitSha)} ساخته می‌شود و پس از بررسی سلامت جایگزین نسخهٔ فعلی خواهد شد. ادامه می‌دهید؟`}
                      label="بازگشت به این نسخه"
                      url={`${base}/rollback`}
                    />
                  )}

                  {row.status === 'live' && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      confirm="این استقرار متوقف می‌شود و سایت به رندرکنندهٔ داخلی برمی‌گردد. ادامه می‌دهید؟"
                      label="توقف"
                      style="danger"
                      url={`${base}/stop`}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div>
          <Button buttonStyle="secondary" onClick={() => void load()} type="button">
            به‌روزرسانی فهرست
          </Button>
        </div>
      </section>
    </div>
  )
}

export default DeploymentPanel
