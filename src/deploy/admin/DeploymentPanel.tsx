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
 * `POST .../poll` is what advances a deployment: it starts a queued one and asks
 * Coolify for a building one's real state. The jobs queue does the same once a
 * minute without anybody watching; polling here only makes an attended deploy move
 * at the operator's pace. So this is not a passive refresh, which is exactly why it
 * must not run unattended in a loop forever.
 *
 * ## What it derives, and what it does not
 *
 * Nothing. "Needs a redeploy" and "a new version is available" are computed by
 * `GET …/deployment` from the rows and packages; this component only renders them.
 */

type Deployment = {
  attention: null | string
  commitSha: null | string
  createdAt: null | string
  deployedAt: null | string
  domain: null | string
  domainMode: string
  id: string
  lastError: null | string
  logTail: null | string
  needsRedeploy: boolean
  packageName: null | string
  previewDomain: null | string
  previewOpenUrl: null | string
  ref: null | string
  themePackage: null | string
  status: string
  targetName: null | string
}

type UpdateInfo = {
  deployedCommit: null | string
  latestCommit: null | string
  packageRef: string
  updateAvailable: boolean
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
  const [current, setCurrent] = useState<Deployment | null>(null)
  const [update, setUpdate] = useState<null | UpdateInfo>(null)
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
        current?: Deployment | null
        deployments?: Deployment[]
        message?: string
        renderedBy?: string
        update?: null | UpdateInfo
      }

      if (!response.ok) {
        setError(json.message ?? 'وضعیت استقرار خوانده نشد.')
        return
      }

      setError(null)
      setDeployments(json.deployments ?? [])
      setCurrent(json.current ?? null)
      setUpdate(json.update ?? null)
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

  const live = current?.status === 'live' ? current : null
  const production = live && live.domainMode !== 'preview' ? live : null
  const previewRow =
    deployments.find((row) => row.domainMode === 'preview' && row.status === 'live') ??
    deployments.find(
      (row) => row.domainMode === 'preview' && PENDING.has(row.status),
    ) ??
    null
  const productionPackageKey =
    (production?.themePackage &&
      packages.find((p) => p.id === production.themePackage)?.key) ||
    packageKey

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

        {renderedBy === 'deployment' && production ? (
          <div className="banner banner--type-success">
            پوستهٔ «{production.packageName ?? '—'}» روی <code dir="ltr">{production.domain}</code> فعال است
            — {MODE_LABELS[production.domainMode] ?? production.domainMode}.
          </div>
        ) : (
          <div className="banner banner--type-default">
            دامنهٔ اصلی این سایت با رندرکنندهٔ داخلی سرویس داده می‌شود.
            {live?.domainMode === 'preview' && ' یک پوسته فقط روی زیردامنهٔ پیش‌نمایش در حال اجراست.'}
          </div>
        )}

        {current && (
          <dl
            style={{
              columnGap: '1.5rem',
              display: 'grid',
              gridTemplateColumns: 'max-content 1fr',
              margin: 0,
              rowGap: '0.4rem',
            }}
          >
            <dt>پوسته</dt>
            <dd style={{ margin: 0 }}>{current.packageName ?? '—'}</dd>
            <dt>وضعیت</dt>
            <dd style={{ margin: 0 }}>{STATUS_LABELS[current.status] ?? current.status}</dd>
            <dt>حالت دامنه</dt>
            <dd style={{ margin: 0 }}>{MODE_LABELS[current.domainMode] ?? current.domainMode}</dd>
            <dt>سرور</dt>
            <dd style={{ margin: 0 }}>{current.targetName ?? '—'}</dd>
            <dt>کامیت</dt>
            <dd style={{ margin: 0 }}>
              <code dir="ltr">{shortSha(current.commitSha)}</code>
              {current.ref ? (
                <>
                  {' '}
                  از <code dir="ltr">{current.ref}</code>
                </>
              ) : null}
            </dd>
            <dt>میزبان</dt>
            <dd style={{ margin: 0 }}>
              <code dir="ltr">{current.domain ?? '—'}</code>
            </dd>
            {current.previewDomain && current.previewDomain !== current.domain && (
              <>
                <dt>زیردامنهٔ پیش‌نمایش</dt>
                <dd style={{ margin: 0 }}>
                  <code dir="ltr">{current.previewDomain}</code>
                </dd>
              </>
            )}
          </dl>
        )}

        {current?.attention && (
          <div className="banner banner--type-error" role="alert">
            {current.attention}
          </div>
        )}

        {update?.updateAvailable && (
          <div className="banner banner--type-info" role="status">
            <strong>نسخهٔ جدید پوسته موجود است</strong> — کامیت <code dir="ltr">{shortSha(update.deployedCommit)}</code>{' '}
            در production در حال اجراست؛ همگام‌سازی گیت‌هاب اکنون{' '}
            <code dir="ltr">{shortSha(update.latestCommit)}</code> (از <code dir="ltr">{update.packageRef}</code>) را
            پیشنهاد می‌دهد.
            {previewRow?.commitSha === update.latestCommit && previewRow.status === 'live' ? (
              <> یک پیش‌نمایش با این کامیت آماده است.</>
            ) : null}
          </div>
        )}

        {previewRow?.previewOpenUrl && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
            <Button
              buttonStyle="secondary"
              el="anchor"
              newTab
              url={previewRow.previewOpenUrl}
            >
              باز کردن پیش‌نمایش
            </Button>
            <span style={{ color: 'var(--theme-elevation-600)', fontSize: '0.85rem' }}>
              کامیت <code dir="ltr">{shortSha(previewRow.commitSha)}</code>
              {' — '}
              <code dir="ltr">{previewRow.previewOpenUrl}</code>
            </span>
          </div>
        )}

        {current?.status === 'failed' && current.lastError && (
          <div className="banner banner--type-error">{current.lastError}</div>
        )}

        {current && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
            {update?.updateAvailable && production && productionPackageKey ? (
              <>
                <ActionButton
                  body={{ domainMode: 'preview', package: productionPackageKey }}
                  label="پیش‌نمایش نسخهٔ جدید"
                  onSuccess={load}
                  style="primary"
                  successMessage="پیش‌نمایش نسخهٔ جدید در صف قرار گرفت."
                  url={base}
                />
                <ActionButton
                  confirm="پس از بررسی سلامت، نسخهٔ جدید جایگزین production روی دامنهٔ مشتری می‌شود. ادامه می‌دهید؟"
                  label="استقرار نسخهٔ جدید در production"
                  onSuccess={load}
                  style="secondary"
                  successMessage="استقرار production در صف قرار گرفت."
                  url={`${base}/redeploy`}
                />
              </>
            ) : (
              <ActionButton
                confirm={
                  current.domainMode === 'preview'
                    ? undefined
                    : 'یک استقرار تازه ساخته می‌شود و پس از بررسی سلامت جایگزین نسخهٔ فعلی روی دامنهٔ مشتری خواهد شد. ادامه می‌دهید؟'
                }
                label={current.needsRedeploy ? 'استقرار مجدد (دامنهٔ جدید)' : 'استقرار مجدد'}
                onSuccess={load}
                style={current.needsRedeploy ? 'primary' : 'secondary'}
                successMessage="استقرار مجدد در صف قرار گرفت."
                url={`${base}/redeploy`}
              />
            )}

            {live && (
              <ActionButton
                body={{ deployment: live.id }}
                confirm={
                  live.domainMode === 'preview'
                    ? undefined
                    : 'این استقرار متوقف می‌شود و سایت به رندرکنندهٔ داخلی برمی‌گردد. ادامه می‌دهید؟'
                }
                label="توقف این استقرار"
                onSuccess={load}
                style="danger"
                url={`${base}/stop`}
              />
            )}

            {renderedBy === 'deployment' && (
              <ActionButton
                confirm="سایت به رندرکنندهٔ داخلی برمی‌گردد و همهٔ استقرارهای فعال آن متوقف می‌شوند. ادامه می‌دهید؟"
                label="بازگشت به رندرکنندهٔ داخلی"
                onSuccess={load}
                style="danger"
                successMessage="سایت به رندرکنندهٔ داخلی بازگشت."
                url={`${base}/revert`}
              />
            )}
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
              confirm={
                domainMode === 'preview'
                  ? undefined
                  : 'این پوسته پس از بررسی سلامت روی دامنهٔ مشتری فعال می‌شود. ادامه می‌دهید؟'
              }
              disabled={!packageKey || Boolean(modeBlocked)}
              label="شروع استقرار"
              onSuccess={load}
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
                  {STATUS_LABELS[row.status] ?? row.status} — {row.packageName ?? '—'} روی{' '}
                  <code dir="ltr">{row.domain ?? '—'}</code> ({MODE_LABELS[row.domainMode] ?? row.domainMode})
                </div>

                {row.attention && (
                  <div className="banner banner--type-error" style={{ margin: 0 }}>
                    {row.attention}
                  </div>
                )}

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
                  {row.previewOpenUrl && row.domainMode === 'preview' && row.status === 'live' && (
                    <Button buttonStyle="secondary" el="anchor" newTab url={row.previewOpenUrl}>
                      باز کردن پیش‌نمایش
                    </Button>
                  )}

                  {PENDING.has(row.status) && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      label="بررسی وضعیت"
                      onSuccess={load}
                      url={`${base}/poll`}
                    />
                  )}

                  {row.status === 'verifying' && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      label="بررسی سلامت و فعال‌سازی"
                      onSuccess={load}
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
                      onSuccess={load}
                      url={`${base}/rollback`}
                    />
                  )}

                  {row.status === 'live' && row.id !== live?.id && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      label="توقف"
                      onSuccess={load}
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
