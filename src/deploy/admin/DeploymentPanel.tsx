'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Banner, Button, Collapsible, Pill, SelectInput } from '@payloadcms/ui'

import { formatDate, formatNumber } from '@/lib/format'

import { ActionButton } from './ActionButton'
import { DemoPackPanel } from './DemoPackPanel'
import { ReadinessChecklist } from './ReadinessChecklist'

/**
 * The per-site deployment console: `/admin/collections/sites/:id/deployment`.
 *
 * ## Three steps, one action each
 *
 * A theme reaches a customer's domain in exactly one way: pick the theme, build a
 * **preview** on its own subdomain and look at it, then **publish that same build** to
 * the domain. The console is laid out as those three numbered steps, each with one
 * primary button, above a status overview that says what runs where.
 *
 * It used to offer the same two operations under five labels («پیش‌نمایش نسخهٔ جدید» /
 * «استقرار پیش‌نمایش», «انتشار آرتیفکت آزموده‌شده» / «انتشار روی دامنه», plus three
 * «استقرار مجدد» buttons), and two of those did something other than their label:
 * «استقرار مجدد production» rebuilt the artifact production already ran — an operator
 * pressing it to ship a fix got the old version back — and «استقرار مجدد پیش‌نمایش»
 * sent no lane, so the server started from the active deployment and rebuilt
 * *production*, unconfirmed. Publishing now always names the build it ships (the
 * preview's artifact and commit); re-running the current production build is a
 * separate, confirmed, explicitly-worded action for what it is actually for — applying
 * changed «تنظیمات پوسته» variables or a new primary domain.
 *
 * ## Why it polls
 *
 * A deploy is a queued job that takes minutes. `POST .../poll` is what advances one: it
 * starts a queued row and asks Coolify for a building one's real state. The interval is
 * conservative — every tick is a Coolify API call — and stops as soon as nothing is
 * pending, so an idle console costs nothing.
 *
 * ## What it derives, and what it does not
 *
 * "Needs a redeploy" and "a new version is available" are computed by
 * `GET …/deployment`; this component only renders them.
 */

type Deployment = {
  attention: null | string
  artifactSource?: string
  themeArtifact?: null | string
  imageDigest?: null | string
  commitSha: null | string
  createdAt: null | string
  deployedAt: null | string
  domain: null | string
  domainMode: string
  id: string
  lane?: string
  lastError: null | string
  logTail: null | string
  needsRedeploy: boolean
  packageName: null | string
  previewDomain: null | string
  previewOpenUrl: null | string
  ref: null | string
  themeBinding?: null | string
  runtime?: null | {
    appName?: null | string
    appUuid?: null | string
    applicationHostname?: null | string
    bindingState?: null | string
    coolifyProjectUuid?: null | string
    environmentName?: null | string
    serverUuid?: null | string
  }
  themePackage: null | string
  status: string
  targetName: null | string
}

type UpdateInfo = {
  deployedCommit: null | string
  latestCommit: null | string
  sourceUpdateAvailable?: boolean
  artifactReady?: boolean
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
  live: 'فعال',
  queued: 'در صف',
  removed: 'حذف‌شده',
  stopped: 'متوقف',
  verifying: 'در حال بررسی سلامت',
}

const MODE_LABELS: Record<string, string> = {
  direct: 'دامنه',
  edge: 'دامنه (Caddy قدیمی)',
  preview: 'پیش‌نمایش',
}

/** Mirrors `isPending` in `src/lib/deploy/status.ts` — the states still expecting work. */
const PENDING = new Set(['queued', 'creating', 'building', 'verifying'])

const POLL_MS = 5000

const laneOf = (row: Deployment): 'preview' | 'production' =>
  row.lane === 'preview' || row.lane === 'production'
    ? row.lane
    : row.domainMode === 'preview'
      ? 'preview'
      : 'production'

const pillStyle = (status: string): 'error' | 'light-gray' | 'success' | 'warning' => {
  if (status === 'live') return 'success'
  if (status === 'failed') return 'error'
  if (PENDING.has(status)) return 'warning'
  return 'light-gray'
}

const StatusPill: React.FC<{ status: string }> = ({ status }) => (
  <Pill pillStyle={pillStyle(status)} size="small">
    {STATUS_LABELS[status] ?? status}
  </Pill>
)

const shortSha = (sha: null | string | undefined): string => (sha ? sha.slice(0, 8) : '—')

/** Jalali, via the house helper — a deployment timeline is where a misread date costs something. */
const formatWhen = (value: null | string): string => {
  if (!value) return '—'
  return formatDate(value, 'fa', { dateStyle: 'medium', timeStyle: 'short' }) || value
}

/** The row a lane shows: what is serving, else what is on its way, else the last attempt. */
const laneRow = (rows: Deployment[], lane: 'preview' | 'production'): Deployment | null => {
  const inLane = rows.filter((row) => laneOf(row) === lane && row.status !== 'removed')
  return (
    inLane.find((row) => PENDING.has(row.status)) ??
    inLane.find((row) => row.status === 'live') ??
    inLane[0] ??
    null
  )
}

const LaneSummary: React.FC<{
  empty: string
  row: Deployment | null
  title: string
  children?: React.ReactNode
}> = ({ children, empty, row, title }) => (
  <div className="theme-card">
    <div className="theme-card__head">
      <h3>{title}</h3>
      {row && <StatusPill status={row.status} />}
    </div>
    {row ? (
      <dl className="theme-facts">
        <dt>پوسته</dt>
        <dd>{row.packageName ?? '—'}</dd>
        <dt>نسخه</dt>
        <dd>
          <code dir="ltr">{shortSha(row.commitSha)}</code>
        </dd>
        <dt>نشانی</dt>
        <dd>
          <code dir="ltr">{laneOf(row) === 'preview' ? (row.previewOpenUrl ?? '—') : (row.domain ?? '—')}</code>
        </dd>
        <dt>{row.status === 'live' ? 'فعال از' : 'آخرین تلاش'}</dt>
        <dd>{formatWhen(row.deployedAt ?? row.createdAt)}</dd>
      </dl>
    ) : (
      <p className="theme-console__muted">{empty}</p>
    )}
    {row?.status === 'failed' && row.lastError && <Banner type="error">{row.lastError}</Banner>}
    {row?.attention && <Banner type="error">{row.attention}</Banner>}
    {children}
  </div>
)

const Step: React.FC<{
  children: React.ReactNode
  description: React.ReactNode
  done: boolean
  number: number
  title: string
}> = ({ children, description, done, number, title }) => (
  <section className="theme-card">
    <div className="theme-card__head">
      <h2 className="theme-card__title">
        <span className={`theme-card__step${done ? ' theme-card__step--done' : ''}`}>
          {done ? '✓' : formatNumber(number, 'fa')}
        </span>
        {title}
      </h2>
    </div>
    <p className="theme-console__muted">{description}</p>
    {children}
  </section>
)

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
  const [update, setUpdate] = useState<null | UpdateInfo>(null)
  const [renderedBy, setRenderedBy] = useState<string>('platform')
  const [packages, setPackages] = useState<ThemePackage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<null | string>(null)

  const [packageKey, setPackageKey] = useState('')
  const [assignedThemePackage, setAssignedThemePackage] = useState<null | string>(null)

  // A ref, not state: the polling effect reads it without wanting to re-subscribe.
  const pollingRef = useRef(false)

  const base = `/api/platform/sites/${siteId}/deployment`

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { credentials: 'same-origin' })
      const json = (await response.json()) as {
        assignedThemePackage?: null | string
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
      setUpdate(json.update ?? null)
      setRenderedBy(json.renderedBy ?? 'platform')
      setAssignedThemePackage(json.assignedThemePackage ?? null)
    } catch {
      setError('ارتباط با سرور برقرار نشد.')
    } finally {
      setLoading(false)
    }
  }, [base])

  useEffect(() => {
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

  if (loading) return <p className="theme-console__muted">در حال بارگذاری…</p>

  const productionRow = laneRow(deployments, 'production')
  const previewRow = laneRow(deployments, 'preview')
  const productionLive = productionRow?.status === 'live' ? productionRow : null
  const previewLive = previewRow?.status === 'live' ? previewRow : null

  /**
   * Only published packages, and only those that declare this site's type. The server
   * refuses the rest — offering them here would just be a menu of ways to get an error.
   */
  const eligible = packages.filter(
    (pkg) => pkg.status === 'published' && pkg.siteTypes.includes(siteType),
  )
  const assignedPkg = assignedThemePackage
    ? packages.find((p) => p.id === assignedThemePackage)
    : undefined
  const selectedKey = packageKey || assignedPkg?.key || ''
  const selected = eligible.find((pkg) => pkg.key === selectedKey) ?? null

  const productionBlocked = ((): null | string => {
    if (!domainVerified) {
      return `دامنهٔ «${siteDomain}» هنوز تأیید نشده است؛ پس از تأیید DNS می‌توانید روی دامنه منتشر کنید. پیش‌نمایش همین حالا هم ممکن است.`
    }
    if (selected && !selected.proxiesApi) {
      return 'این پوسته مسیرهای /api را پراکسی نمی‌کند و روی دامنه قابل انتشار نیست.'
    }
    return null
  })()

  /** What «انتشار» ships: the reviewed preview build when there is one, else the package's latest. */
  const publishCommit = previewLive?.commitSha ?? null
  const alreadyPublished = Boolean(
    productionLive && publishCommit && productionLive.commitSha === publishCommit,
  )
  const previewAhead = Boolean(
    previewLive && productionLive && previewLive.commitSha !== productionLive.commitSha,
  )

  /**
   * A history row can only be re-run (rollback) if it knows what to run: a
   * `registry_image` row with neither an artifact link nor a digest failed before
   * anything was built.
   */
  const rowIsRerunnable = (row: Deployment): boolean =>
    row.artifactSource !== 'registry_image' || Boolean(row.themeArtifact || row.imageDigest)

  return (
    <div className="theme-console">
      <div className="theme-console__intro">
        <h1>استقرار پوسته — {siteName}</h1>
        <div className="theme-console__meta">
          <code dir="ltr">{siteDomain}</code>
          <Pill pillStyle={domainVerified ? 'success' : 'warning'} size="small">
            {domainVerified ? 'دامنه تأیید شده' : 'دامنه تأیید نشده'}
          </Pill>
          <Pill pillStyle={renderedBy === 'deployment' ? 'success' : 'light-gray'} size="small">
            {renderedBy === 'deployment' ? 'دامنه با پوستهٔ مستقر سرویس می‌شود' : 'دامنه با رندرکنندهٔ داخلی سرویس می‌شود'}
          </Pill>
        </div>
        <p className="theme-console__muted">
          سه قدم: پوسته را انتخاب کنید، پیش‌نمایش بسازید و روی زیردامنهٔ آن بررسی کنید، سپس همان
          نسخه را روی دامنه منتشر کنید. پیش‌نمایش هیچ اثری روی سایت مشتری ندارد. این صفحه فقط برای
          کارکنان سکو است.
        </p>
      </div>

      {error && <Banner type="error">{error}</Banner>}

      <ReadinessChecklist
        refreshKey={`${assignedThemePackage ?? ''}:${deployments.map((row) => `${row.id}${row.status}`).join(',')}`}
        settingsHref={`/admin/collections/sites/${siteId}/theme-settings`}
        siteId={siteId}
      />

      {/* ---------------------------------------------------------------- */}
      {/* What runs where */}
      {/* ---------------------------------------------------------------- */}
      <div className="theme-lanes">
        <LaneSummary
          empty="هنوز چیزی روی دامنه منتشر نشده است."
          row={productionRow}
          title="روی دامنه"
        >
          {productionLive && productionLive.domain && (
            <div className="theme-actions">
              <Button buttonStyle="secondary" el="anchor" newTab size="small" url={`https://${productionLive.domain}`}>
                باز کردن سایت
              </Button>
            </div>
          )}
        </LaneSummary>
        <LaneSummary empty="هنوز پیش‌نمایشی ساخته نشده است." row={previewRow} title="پیش‌نمایش">
          {previewLive?.previewOpenUrl && (
            <div className="theme-actions">
              <Button buttonStyle="secondary" el="anchor" newTab size="small" url={previewLive.previewOpenUrl}>
                باز کردن پیش‌نمایش
              </Button>
            </div>
          )}
        </LaneSummary>
      </div>

      {update?.sourceUpdateAvailable && update.artifactReady === false && (
        <Banner type="info">
          کامیت تازهٔ <code dir="ltr">{shortSha(update.latestCommit)}</code> شناسایی شد، اما تصویر
          ساخته‌شدهٔ آن هنوز آماده نیست؛ پس از پایان ساخت در CI می‌توانید از آن پیش‌نمایش بسازید.
        </Banner>
      )}
      {update?.updateAvailable && !(previewLive && previewLive.commitSha === update.latestCommit) && (
        <Banner type="info">
          نسخهٔ تازهٔ پوسته (<code dir="ltr">{shortSha(update.latestCommit)}</code> از{' '}
          <code dir="ltr">{update.packageRef}</code>) آماده است؛ روی دامنه هنوز{' '}
          <code dir="ltr">{shortSha(update.deployedCommit)}</code> اجرا می‌شود. در قدم ۲ از آن
          پیش‌نمایش بسازید، سپس در قدم ۳ منتشرش کنید.
        </Banner>
      )}
      {previewAhead && (
        <Banner type="info">
          پیش‌نمایش نسخهٔ <code dir="ltr">{shortSha(previewLive?.commitSha)}</code> را اجرا می‌کند و
          روی دامنه هنوز <code dir="ltr">{shortSha(productionLive?.commitSha)}</code> است. پس از
          بررسی پیش‌نمایش، در قدم ۳ «انتشار روی دامنه» را بزنید.
        </Banner>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Step 1 — theme */}
      {/* ---------------------------------------------------------------- */}
      <Step
        description="پوسته‌ای که این سایت با آن ساخته می‌شود. فقط پوسته‌های منتشرشده‌ای فهرست می‌شوند که از نوع این سایت پشتیبانی می‌کنند."
        done={Boolean(assignedPkg)}
        number={1}
        title="انتخاب پوسته"
      >
        {eligible.length === 0 ? (
          <Banner type="info">هیچ پوستهٔ منتشرشده‌ای برای سایت از نوع «{siteType}» وجود ندارد.</Banner>
        ) : (
          <>
            <SelectInput
              label="پوسته"
              name="package"
              onChange={(option) => setPackageKey(String((option as Option | null)?.value ?? ''))}
              options={eligible.map((pkg) => ({ label: `${pkg.name} (${pkg.key})`, value: pkg.key }))}
              path="package"
              value={selectedKey}
            />
            {selectedKey && selectedKey !== assignedPkg?.key && (
              <div className="theme-actions">
                <ActionButton
                  body={{ package: selectedKey }}
                  label="ثبت این پوسته برای سایت"
                  onSuccess={load}
                  style="secondary"
                  successMessage="پوسته برای این سایت ثبت شد."
                  url={`/api/platform/sites/${siteId}/theme-assignment`}
                />
              </div>
            )}
          </>
        )}
      </Step>

      {/* ---------------------------------------------------------------- */}
      {/* Step 2 — preview */}
      {/* ---------------------------------------------------------------- */}
      <Step
        description="آخرین نسخهٔ پوسته روی زیردامنهٔ جداگانه‌ای ساخته می‌شود تا با محتوای واقعی این سایت بررسی شود. دامنه و DNS مشتری دست نمی‌خورد."
        done={Boolean(previewLive && (!update?.updateAvailable || previewLive.commitSha === update.latestCommit))}
        number={2}
        title="پیش‌نمایش"
      >
        {previewRow && PENDING.has(previewRow.status) && (
          <Banner type="info">
            پیش‌نمایش در حال ساخت است ({STATUS_LABELS[previewRow.status]})؛ این صفحه خودکار به‌روز
            می‌شود.
          </Banner>
        )}
        <div className="theme-actions">
          <ActionButton
            body={{ lane: 'preview', package: selectedKey }}
            disabled={!selectedKey || Boolean(previewRow && PENDING.has(previewRow.status))}
            label={previewLive ? 'ساخت پیش‌نمایش تازه از آخرین نسخه' : 'ساخت پیش‌نمایش'}
            onSuccess={load}
            style="primary"
            successMessage="ساخت پیش‌نمایش در صف قرار گرفت."
            url={base}
          />
          {previewLive?.previewOpenUrl && (
            <Button buttonStyle="secondary" el="anchor" newTab url={previewLive.previewOpenUrl}>
              باز کردن پیش‌نمایش
            </Button>
          )}
        </div>
      </Step>

      {/* ---------------------------------------------------------------- */}
      {/* Step 3 — publish */}
      {/* ---------------------------------------------------------------- */}
      <Step
        description={
          <>
            همان نسخه‌ای که در پیش‌نمایش بررسی کرده‌اید
            {publishCommit ? (
              <>
                {' '}
                (<code dir="ltr">{shortSha(publishCommit)}</code>)
              </>
            ) : null}{' '}
            روی <code dir="ltr">{siteDomain}</code> منتشر می‌شود؛ پس از بررسی سلامت جایگزین نسخهٔ
            فعلی می‌شود و تا آن لحظه سایت با نسخهٔ قبلی سرویس می‌دهد.
          </>
        }
        done={Boolean(productionLive && (alreadyPublished || !previewLive))}
        number={3}
        title="انتشار روی دامنه"
      >
        {productionBlocked && <Banner type="error">{productionBlocked}</Banner>}
        {alreadyPublished && (
          <Banner type="success">روی دامنه همین نسخهٔ پیش‌نمایش در حال اجراست.</Banner>
        )}
        {productionRow && PENDING.has(productionRow.status) && (
          <Banner type="info">
            انتشار در جریان است ({STATUS_LABELS[productionRow.status]})؛ این صفحه خودکار به‌روز می‌شود.
          </Banner>
        )}
        <div className="theme-actions">
          <ActionButton
            body={{
              artifact: previewLive?.themeArtifact ?? undefined,
              lane: 'production',
              package: selectedKey,
            }}
            confirm={`نسخهٔ ${publishCommit ? shortSha(publishCommit) : 'آخرین'} روی ${siteDomain} منتشر می‌شود و پس از بررسی سلامت جایگزین نسخهٔ فعلی خواهد شد. ادامه می‌دهید؟`}
            confirmHeading="انتشار روی دامنه"
            disabled={
              !selectedKey ||
              Boolean(productionBlocked) ||
              alreadyPublished ||
              Boolean(productionRow && PENDING.has(productionRow.status))
            }
            label={publishCommit ? `انتشار نسخهٔ ${shortSha(publishCommit)} روی دامنه` : 'انتشار روی دامنه'}
            onSuccess={load}
            style="primary"
            successMessage="انتشار روی دامنه در صف قرار گرفت."
            url={base}
          />
          {productionRow && laneOf(productionRow) === 'production' && productionRow.status !== 'removed' && (
            <ActionButton
              body={{ lane: 'production' }}
              confirm={`نسخهٔ فعلی روی دامنه (${shortSha(productionRow.commitSha)}) دوباره ساخته و جایگزین می‌شود — نسخهٔ جدیدی منتشر نمی‌شود. برای اعمال متغیرهای تغییرکردهٔ «تنظیمات پوسته»، دامنهٔ اصلی جدید یا بازیابی یک کانتینر خراب است. ادامه می‌دهید؟`}
              confirmHeading="اجرای دوبارهٔ نسخهٔ فعلی"
              label={productionRow.needsRedeploy ? 'استقرار مجدد روی دامنهٔ جدید' : 'اجرای دوبارهٔ نسخهٔ فعلی'}
              onSuccess={load}
              style={productionRow.needsRedeploy ? 'primary' : 'secondary'}
              successMessage="اجرای دوباره در صف قرار گرفت."
              url={`${base}/redeploy`}
            />
          )}
        </div>
      </Step>

      <DemoPackPanel siteId={siteId} siteType={siteType} />

      {/* ---------------------------------------------------------------- */}
      {/* Rarely needed */}
      {/* ---------------------------------------------------------------- */}
      {(productionLive || previewLive || renderedBy === 'deployment') && (
        <Collapsible header="توقف و بازگشت" initCollapsed>
          <div className="theme-form__fields">
            <p className="theme-console__muted">
              توقف، کانتینر را حذف نمی‌کند و تاریخچه می‌ماند. «بازگشت به رندرکنندهٔ داخلی» همهٔ
              استقرارهای این سایت را متوقف می‌کند و دامنه را به سایت‌ساز داخلی برمی‌گرداند.
            </p>
            <div className="theme-actions">
              {previewLive && (
                <ActionButton
                  body={{ deployment: previewLive.id }}
                  label="توقف پیش‌نمایش"
                  onSuccess={load}
                  style="secondary"
                  url={`${base}/stop`}
                />
              )}
              {productionLive && (
                <ActionButton
                  body={{ deployment: productionLive.id }}
                  confirm="پوسته روی دامنه متوقف می‌شود و سایت به رندرکنندهٔ داخلی برمی‌گردد. ادامه می‌دهید؟"
                  label="توقف روی دامنه"
                  onSuccess={load}
                  style="danger"
                  url={`${base}/stop`}
                />
              )}
              {renderedBy === 'deployment' && (
                <ActionButton
                  confirm="همهٔ استقرارهای این سایت متوقف می‌شوند و دامنه با رندرکنندهٔ داخلی سرویس داده می‌شود. ادامه می‌دهید؟"
                  label="بازگشت به رندرکنندهٔ داخلی"
                  onSuccess={load}
                  style="danger"
                  successMessage="سایت به رندرکنندهٔ داخلی بازگشت."
                  url={`${base}/revert`}
                />
              )}
            </div>
          </div>
        </Collapsible>
      )}

      <Collapsible header={`تاریخچهٔ استقرارها (${formatNumber(deployments.length, 'fa')})`} initCollapsed>
        <div className="theme-history">
          {pending.length > 0 && (
            <Banner type="info">
              {formatNumber(pending.length, 'fa')} استقرار در جریان است؛ این صفحه هر{' '}
              {formatNumber(POLL_MS / 1000, 'fa')} ثانیه به‌روز می‌شود.
            </Banner>
          )}

          {deployments.length === 0 ? (
            <p className="theme-console__muted">هنوز هیچ استقراری برای این سایت انجام نشده است.</p>
          ) : (
            deployments.map((row) => (
              <div className="theme-history__row" key={row.id}>
                <div className="theme-console__meta">
                  <StatusPill status={row.status} />
                  <strong>{MODE_LABELS[row.domainMode] ?? row.domainMode}</strong>
                  <span>{row.packageName ?? '—'}</span>
                  <code dir="ltr">{shortSha(row.commitSha)}</code>
                </div>
                <div className="theme-console__muted" style={{ fontSize: '0.85rem' }}>
                  <code dir="ltr">{row.domain ?? '—'}</code>
                  {' — ساخته‌شده: '}
                  {formatWhen(row.createdAt)}
                  {row.deployedAt ? ` — فعال‌شده: ${formatWhen(row.deployedAt)}` : ''}
                </div>

                {row.attention && <Banner type="error">{row.attention}</Banner>}
                {row.lastError && <Banner type="error">{row.lastError}</Banner>}

                {row.logTail && (
                  <Collapsible header="گزارش ساخت" initCollapsed>
                    <pre className="theme-log" dir="ltr">
                      {row.logTail}
                    </pre>
                  </Collapsible>
                )}

                <div className="theme-actions">
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
                   * A rollback creates a new deployment pinned to that row's commit, so the
                   * history stays a history. A registry row that never reached an artifact
                   * has nothing immutable to roll back to.
                   */}
                  {row.commitSha && row.status !== 'live' && rowIsRerunnable(row) && (
                    <ActionButton
                      body={{ deployment: row.id }}
                      confirm={`یک استقرار تازه با نسخهٔ ${shortSha(row.commitSha)} ساخته می‌شود و پس از بررسی سلامت جایگزین نسخهٔ فعلی ${laneOf(row) === 'preview' ? 'پیش‌نمایش' : 'روی دامنه'} خواهد شد. ادامه می‌دهید؟`}
                      confirmHeading="بازگشت به این نسخه"
                      label="بازگشت به این نسخه"
                      onSuccess={load}
                      url={`${base}/rollback`}
                    />
                  )}
                </div>
              </div>
            ))
          )}

          <div className="theme-actions">
            <Button buttonStyle="secondary" onClick={() => void load()} size="small" type="button">
              به‌روزرسانی فهرست
            </Button>
          </div>
        </div>
      </Collapsible>

      {(productionRow?.runtime || previewRow?.runtime) && (
        <Collapsible header="جزئیات زیرساخت (Coolify)" initCollapsed>
          <div className="theme-lanes">
            {[productionRow, previewRow].map((row) =>
              row?.runtime ? (
                <dl className="theme-facts" dir="ltr" key={row.id}>
                  <dt>Lane</dt>
                  <dd>{laneOf(row)}</dd>
                  <dt>Deployment</dt>
                  <dd>
                    <code>{row.id}</code>
                  </dd>
                  <dt>Server</dt>
                  <dd>{row.targetName ?? '—'}</dd>
                  <dt>Application</dt>
                  <dd>
                    <code>{row.runtime.appName ?? '—'}</code>
                  </dd>
                  <dt>App UUID</dt>
                  <dd>
                    <code>{row.runtime.appUuid ?? '—'}</code>
                  </dd>
                  <dt>Hostname</dt>
                  <dd>
                    <code>{row.runtime.applicationHostname ?? '—'}</code>
                  </dd>
                  <dt>Project</dt>
                  <dd>
                    <code>{row.runtime.coolifyProjectUuid ?? '—'}</code>
                  </dd>
                  <dt>Environment</dt>
                  <dd>
                    <code>{row.runtime.environmentName ?? '—'}</code>
                  </dd>
                  <dt>Binding</dt>
                  <dd>
                    <code>{row.themeBinding ?? '—'}</code> ({row.runtime.bindingState ?? '—'})
                  </dd>
                </dl>
              ) : null,
            )}
          </div>
        </Collapsible>
      )}
    </div>
  )
}

export default DeploymentPanel
