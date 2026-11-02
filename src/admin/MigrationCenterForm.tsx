'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { Banner, Button, useTranslation } from '@payloadcms/ui'

import type { MigrationCenterView } from '@/lib/migration/center'

/**
 * «مرکز مهاجرت» — the WordPress/WooCommerce import wizard (issue #166).
 *
 * One screen, in the order the work is actually safe to do: connect a
 * read-only source, create a job with reviewed money settings, discover,
 * dry-run, import, keep syncing while WordPress stays live, reconcile, and
 * only then cut over behind the owner's write-fence confirmation. The form
 * is a client of `/api/site/migration…`; it never receives a stored secret,
 * and every consequential action re-checks site ownership on the server.
 */

type View = MigrationCenterView
type Job = View['jobs'][number]
type Source = View['sources'][number]
type Loose = Record<string, unknown>

const OPERATIONS = [
  { en: 'Discover source', fa: 'کشف مبدأ', value: 'discover' },
  { en: 'Dry run (no destination writes)', fa: 'اجرای خشک (بدون نوشتن در مقصد)', value: 'dry-run' },
  { en: 'Import', fa: 'ورود داده‌ها', value: 'import' },
  { en: 'Delta sync', fa: 'هم‌گام‌سازی تغییرات', value: 'sync' },
  { en: 'Reconcile', fa: 'تطبیق کامل', value: 'reconcile' },
  { en: 'Cut over', fa: 'برش نهایی', value: 'cutover' },
  { en: 'Roll back', fa: 'بازگشت', value: 'rollback' },
] as const

const BOOLEAN_SETTINGS = [
  { en: 'Content (posts, pages, custom types)', fa: 'محتوا (نوشته، برگه، گونه‌های سفارشی)', key: 'includeContent' },
  { en: 'Media library', fa: 'کتابخانه رسانه', key: 'includeMedia' },
  { en: 'Products', fa: 'محصولات', key: 'includeProducts' },
  { en: 'Customers', fa: 'مشتریان', key: 'includeCustomers' },
  { en: 'Coupons', fa: 'کوپن‌ها', key: 'includeCoupons' },
  { en: 'Orders & refunds', fa: 'سفارش‌ها و بازپرداخت‌ها', key: 'includeOrders' },
  { en: 'Apply redirects to the live site', fa: 'اعمال تغییرمسیرها روی سایت زنده', key: 'applyRedirects' },
  { en: 'I confirm source amounts are Rial and this site prices in Toman', fa: 'تأیید می‌کنم مبالغ مبدأ ریالی است و سایت تومانی قیمت می‌دهد', key: 'confirmedRialToToman' },
  { en: 'Allow commerce import on a non-store site', fa: 'ورود داده فروشگاه روی سایت غیرفروشگاهی مجاز است', key: 'allowCommerceOnNonStoreSite' },
] as const

const CURRENCIES = ['IRT', 'IRR', 'USD', 'EUR', 'GBP', 'AED', 'TRY', 'CAD', 'AUD', 'CHF', 'CNY', 'JPY']

const box: React.CSSProperties = {
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: 8,
  display: 'grid',
  gap: '0.75rem',
  marginBottom: '1.25rem',
  padding: '1rem',
}
const grid: React.CSSProperties = {
  display: 'grid',
  gap: '0.75rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
}
const inputStyle: React.CSSProperties = {
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-elevation-150)',
  borderRadius: 4,
  color: 'var(--theme-text)',
  minHeight: 38,
  padding: '0.45rem 0.6rem',
  width: '100%',
}
const labelStyle: React.CSSProperties = { display: 'grid', fontSize: '0.85rem', gap: '0.3rem' }

const asRecord = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {}
const asArray = (value: unknown): Loose[] => (Array.isArray(value) ? (value as Loose[]) : [])
const textOf = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

const Field: React.FC<{ children: React.ReactNode; label: string }> = ({ children, label }) => (
  <label style={labelStyle}>
    <span>{label}</span>
    {children}
  </label>
)

export const MigrationCenterForm: React.FC<{
  initial: View
  siteId: string
  siteName: string
}> = ({ initial, siteId, siteName }) => {
  const { i18n } = useTranslation()
  const english = i18n?.language === 'en'
  const t = useCallback((fa: string, en: string) => (english ? en : fa), [english])
  const [view, setView] = useState<View>(initial)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<null | string>(null)
  const [error, setError] = useState<null | string>(null)
  const [sourceId, setSourceId] = useState(initial.sources[0]?.id ?? '')
  const [jobId, setJobId] = useState(initial.jobs[0]?.id ?? '')
  const [writeFence, setWriteFence] = useState(false)
  const [sourceForm, setSourceForm] = useState({
    baseUrl: '',
    name: '',
    wooConsumerKey: '',
    wooConsumerSecret: '',
    wpApplicationPassword: '',
    wpUsername: '',
  })
  const settingsFor = useCallback(
    (candidate?: Job): Loose => ({
      allowCommerceOnNonStoreSite: false,
      applyRedirects: true,
      confirmedRialToToman: false,
      includeContent: true,
      includeCoupons: true,
      includeCustomers: true,
      includeMedia: true,
      includeOrders: true,
      includeProducts: true,
      locale: initial.site?.defaultLocale ?? 'fa',
      sourceCurrency: 'IRT',
      sourceDecimals: 0,
      targetCurrency: 'IRT',
      ...(candidate?.settings ?? {}),
    }),
    [initial.site?.defaultLocale],
  )
  const [settingsDraft, setSettingsDraft] = useState<{ jobId: string; values: Loose }>(() => ({
    jobId: initial.jobs[0]?.id ?? '',
    values: settingsFor(initial.jobs[0]),
  }))

  const source: Source | undefined = useMemo(
    () => view.sources.find((candidate) => candidate.id === sourceId) ?? view.sources[0],
    [sourceId, view.sources],
  )
  const job: Job | undefined = useMemo(
    () => view.jobs.find((candidate) => candidate.id === jobId) ?? view.jobs[0],
    [jobId, view.jobs],
  )
  const active = job?.status === 'queued' || job?.status === 'running'
  const canManage = view.canManage
  // A draft belongs to the job it was typed against. Selecting another job
  // therefore derives that job's saved settings during render instead of
  // copying them through an effect after the wrong values have painted.
  const settings =
    settingsDraft.jobId === (job?.id ?? '') ? settingsDraft.values : settingsFor(job)
  const setSettings = (next: Loose | ((current: Loose) => Loose)): void => {
    setSettingsDraft({
      jobId: job?.id ?? '',
      values: typeof next === 'function' ? next(settings) : next,
    })
  }

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/site/migration?site=${encodeURIComponent(siteId)}`, {
      credentials: 'same-origin',
    })
    const data = (await response.json().catch(() => ({}))) as Loose
    if (response.ok) setView(data as unknown as View)
  }, [siteId])

  useEffect(() => {
    if (!view.jobs.some((candidate) => ['queued', 'running'].includes(candidate.status))) return
    const timer = window.setInterval(() => void refresh(), 8_000)
    return () => window.clearInterval(timer)
  }, [refresh, view.jobs])

  const post = useCallback(
    async (path: string, body: Loose, success: string): Promise<Loose | null> => {
      setPending(true)
      setError(null)
      setMessage(null)
      try {
        const response = await fetch(path, {
          body: JSON.stringify(body),
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
        const data = (await response.json().catch(() => ({}))) as Loose
        if (!response.ok) {
          setError(textOf(data.message) || t('درخواست انجام نشد.', 'The request failed.'))
          return null
        }
        if (Array.isArray(data.sources) && Array.isArray(data.jobs)) setView(data as unknown as View)
        const nextSource = asRecord(data.source)
        const nextJob = asRecord(data.job)
        if (typeof nextSource.id === 'string') setSourceId(nextSource.id)
        if (typeof nextJob.id === 'string') setJobId(nextJob.id)
        setMessage(success)
        return data
      } catch {
        setError(t('ارتباط با سرور برقرار نشد.', 'Could not reach the server.'))
        return null
      } finally {
        setPending(false)
      }
    },
    [t],
  )

  const queue = async (operation: string) => {
    if (!job) return
    if (
      operation === 'cutover' &&
      !window.confirm(
        t(
          'برش نهایی فقط پس از توقف نوشتن روی وردپرس و تطبیق کامل انجام می‌شود. ادامه می‌دهید؟',
          'Cutover runs only after WordPress writes are fenced and reconciliation is clean. Continue?',
        ),
      )
    ) {
      return
    }
    if (
      operation === 'rollback' &&
      !window.confirm(
        t(
          'بازگشت فقط سندهای ساخته مهاجرت را که دست نخورده‌اند حذف می‌کند. ادامه می‌دهید؟',
          'Rollback removes only untouched documents this migration created. Continue?',
        ),
      )
    ) {
      return
    }
    await post(
      `/api/site/migration/job/${job.id}/queue`,
      { operation, site: siteId },
      t('عملیات در صف اجرا قرار گرفت.', 'The operation was queued.'),
    )
  }

  const jobCoverage = asArray(job?.coverage)
  const coverage = jobCoverage.length ? jobCoverage : asArray(source?.coverage)
  const dryReport = asRecord(job?.dryRunReport)
  const dryResources = asArray(dryReport.resources)
  const reconciliation = asRecord(job?.reconciliationReport)
  const blockers = Array.isArray(job?.blockers) ? job.blockers.map(textOf).filter(Boolean) : []
  const counts = asRecord(job?.counts)

  return (
    <div style={{ padding: '1.5rem 0 3rem' }}>
      <h1>
        {t('مرکز مهاجرت از وردپرس و ووکامرس', 'WordPress & WooCommerce Migration Center')} — {siteName}
      </h1>
      <p style={{ maxWidth: 900 }}>
        {t(
          'ترتیب امن کار: اتصال فقط‌خواندنی، کشف، اجرای خشک، ورود، هم‌گام‌سازی تا روز برش، تطبیق، و فقط پس از تأیید توقف نوشتن روی وردپرس: برش نهایی. هیچ رکوردی بی‌صدا حذف نمی‌شود؛ هر رکورد یا وارد می‌شود، یا با منشأ بایگانی، یا در خطاها مسدود و آشکار می‌ماند.',
          'The safe order: read-only connection, discovery, dry run, import, delta sync while WordPress stays live, reconciliation, and cutover only after you confirm WordPress writes are fenced. Nothing is silently skipped: every record is imported, archived with provenance, or visibly blocked.',
        )}
      </p>

      {!canManage && (
        <Banner type="info">
          {t(
            'شما می‌توانید وضعیت مهاجرت را ببینید؛ تغییر اتصال و اجرای عملیات با مالک سایت است.',
            'You can inspect migration state; only the site owner can change the connection or run operations.',
          )}
        </Banner>
      )}
      {error && <Banner type="error">{error}</Banner>}
      {message && <Banner type="success">{message}</Banner>}

      <section style={box}>
        <h2>{t('۱) اتصال مبدأ', '1) Connect the source')}</h2>
        {view.sources.length > 0 && (
          <Field label={t('مبدأ ذخیره‌شده', 'Saved source')}>
            <select
              onChange={(event) => setSourceId(event.target.value)}
              style={inputStyle}
              value={source?.id ?? ''}
            >
              {view.sources.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {candidate.baseUrl} ({candidate.status})
                </option>
              ))}
            </select>
          </Field>
        )}
        {source && (
          <p>
            {t('خلاصه اعتبارنامه:', 'Credentials:')} {source.credentialsSummary ?? '—'}
            {source.lastError ? ` · ${source.lastError}` : ''}
          </p>
        )}
        <div style={grid}>
          <Field label={t('نشانی HTTPS وردپرس', 'WordPress HTTPS URL')}>
            <input
              disabled={!canManage || pending}
              onChange={(event) => setSourceForm((v) => ({ ...v, baseUrl: event.target.value }))}
              placeholder="https://old.example"
              style={inputStyle}
              value={sourceForm.baseUrl}
            />
          </Field>
          <Field label={t('نام اتصال', 'Connection name')}>
            <input
              disabled={!canManage || pending}
              onChange={(event) => setSourceForm((v) => ({ ...v, name: event.target.value }))}
              style={inputStyle}
              value={sourceForm.name}
            />
          </Field>
          <Field label={t('نام کاربری مدیر وردپرس', 'WordPress admin username')}>
            <input
              autoComplete="off"
              disabled={!canManage || pending}
              onChange={(event) => setSourceForm((v) => ({ ...v, wpUsername: event.target.value }))}
              style={inputStyle}
              value={sourceForm.wpUsername}
            />
          </Field>
          <Field label={t('رمز برنامه وردپرس', 'WordPress application password')}>
            <input
              autoComplete="new-password"
              disabled={!canManage || pending}
              onChange={(event) =>
                setSourceForm((v) => ({ ...v, wpApplicationPassword: event.target.value }))
              }
              style={inputStyle}
              type="password"
              value={sourceForm.wpApplicationPassword}
            />
          </Field>
          <Field label={t('کلید مصرف‌کننده ووکامرس (فقط‌خواندنی)', 'Woo consumer key (read-only)')}>
            <input
              autoComplete="off"
              disabled={!canManage || pending}
              onChange={(event) => setSourceForm((v) => ({ ...v, wooConsumerKey: event.target.value }))}
              style={inputStyle}
              value={sourceForm.wooConsumerKey}
            />
          </Field>
          <Field label={t('رمز مصرف‌کننده ووکامرس', 'Woo consumer secret')}>
            <input
              autoComplete="new-password"
              disabled={!canManage || pending}
              onChange={(event) =>
                setSourceForm((v) => ({ ...v, wooConsumerSecret: event.target.value }))
              }
              style={inputStyle}
              type="password"
              value={sourceForm.wooConsumerSecret}
            />
          </Field>
        </div>
        <div>
          <Button
            disabled={!canManage || pending || !sourceForm.baseUrl.trim()}
            onClick={() =>
              void post(
                '/api/site/migration/source',
                { ...sourceForm, site: siteId },
                t('اتصال مبدأ ذخیره شد.', 'The source connection was saved.'),
              )
            }
          >
            {t('ثبت / به‌روزرسانی اتصال', 'Save / update connection')}
          </Button>
        </div>
      </section>

      <section style={box}>
        <h2>{t('۲) کار و تنظیم‌ها', '2) Job & settings')}</h2>
        {view.jobs.length > 0 && (
          <Field label={t('کار مهاجرت', 'Migration job')}>
            <select onChange={(event) => setJobId(event.target.value)} style={inputStyle} value={job?.id ?? ''}>
              {view.jobs.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title} — {candidate.status}
                  {candidate.phase ? ` / ${candidate.phase}` : ''}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div style={grid}>
          <Field label={t('زبان مقصد', 'Destination locale')}>
            <select
              disabled={!canManage || pending}
              onChange={(event) => setSettings((v) => ({ ...v, locale: event.target.value }))}
              style={inputStyle}
              value={textOf(settings.locale)}
            >
              {(view.site?.availableLocales?.length ? view.site.availableLocales : ['fa', 'en']).map(
                (locale) => (
                  <option key={String(locale)} value={String(locale)}>
                    {String(locale)}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label={t('واحد پول ووکامرس', 'WooCommerce currency')}>
            <select
              disabled={!canManage || pending}
              onChange={(event) => setSettings((v) => ({ ...v, sourceCurrency: event.target.value }))}
              style={inputStyle}
              value={textOf(settings.sourceCurrency)}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('واحد پول سایت مقصد', 'Destination site currency')}>
            <select
              disabled={!canManage || pending}
              onChange={(event) => setSettings((v) => ({ ...v, targetCurrency: event.target.value }))}
              style={inputStyle}
              value={textOf(settings.targetCurrency)}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('اعشار قیمت ووکامرس', 'Woo price decimals')}>
            <input
              disabled={!canManage || pending}
              max={4}
              min={0}
              onChange={(event) =>
                setSettings((v) => ({ ...v, sourceDecimals: Number(event.target.value) }))
              }
              style={inputStyle}
              type="number"
              value={Number(settings.sourceDecimals ?? 0)}
            />
          </Field>
        </div>
        <div style={grid}>
          {BOOLEAN_SETTINGS.map((item) => (
            <label key={item.key} style={{ alignItems: 'center', display: 'flex', gap: '0.5rem' }}>
              <input
                checked={settings[item.key] === true}
                disabled={!canManage || pending}
                onChange={(event) => setSettings((v) => ({ ...v, [item.key]: event.target.checked }))}
                type="checkbox"
              />
              <span>{t(item.fa, item.en)}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <Button
            disabled={!canManage || pending || !source}
            onClick={() =>
              source &&
              void post(
                '/api/site/migration/job',
                { settings, site: siteId, sourceId: source.id },
                t('کار مهاجرت ساخته یا به‌روز شد.', 'The migration job was created or updated.'),
              )
            }
          >
            {t('ساخت / استفاده از کار فعال', 'Create / reuse active job')}
          </Button>
          <Button
            buttonStyle="secondary"
            disabled={!canManage || pending || !job || active}
            onClick={() =>
              job &&
              void post(
                `/api/site/migration/job/${job.id}/settings`,
                { settings, site: siteId },
                t('تنظیم‌ها ذخیره شد.', 'Settings saved.'),
              )
            }
          >
            {t('ذخیره تنظیم‌ها', 'Save settings')}
          </Button>
          <Button buttonStyle="secondary" disabled={pending} onClick={() => void refresh()}>
            {t('تازه‌سازی وضعیت', 'Refresh status')}
          </Button>
        </div>
      </section>

      <section style={box}>
        <h2>{t('۳) اجرا', '3) Run')}</h2>
        {job ? (
          <>
            <p>
              <strong>{job.title}</strong> · {job.status}
              {job.phase ? ` · ${job.phase}` : ''}
              {job.lastError ? ` · ${job.lastError}` : ''}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {OPERATIONS.map((operation) => (
                <Button
                  buttonStyle={['cutover', 'rollback'].includes(operation.value) ? 'error' : 'primary'}
                  disabled={
                    !canManage ||
                    pending ||
                    active ||
                    (operation.value === 'cutover' && !job.sourceWriteFenceConfirmedAt)
                  }
                  key={operation.value}
                  onClick={() => void queue(operation.value)}
                >
                  {t(operation.fa, operation.en)}
                </Button>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <Button
                buttonStyle="secondary"
                disabled={!canManage || pending || !active}
                onClick={() =>
                  void post(
                    `/api/site/migration/job/${job.id}/control`,
                    { control: 'pause', site: siteId },
                    t('توقف موقت درخواست شد.', 'Pause requested.'),
                  )
                }
              >
                {t('توقف موقت', 'Pause')}
              </Button>
              <Button
                buttonStyle="secondary"
                disabled={!canManage || pending || job.status !== 'paused'}
                onClick={() =>
                  void post(
                    `/api/site/migration/job/${job.id}/control`,
                    { control: 'run', site: siteId },
                    t('ادامه کار در صف قرار گرفت.', 'Resume queued.'),
                  )
                }
              >
                {t('ادامه', 'Resume')}
              </Button>
              <Button
                buttonStyle="secondary"
                disabled={!canManage || pending}
                onClick={() =>
                  void post(
                    `/api/site/migration/job/${job.id}/control`,
                    { control: 'cancel', site: siteId },
                    t('لغو کار درخواست شد.', 'Cancellation requested.'),
                  )
                }
              >
                {t('لغو', 'Cancel')}
              </Button>
            </div>
            <label style={{ alignItems: 'center', display: 'flex', gap: '0.5rem' }}>
              <input
                checked={writeFence}
                disabled={!canManage || pending || Boolean(job.sourceWriteFenceConfirmedAt)}
                onChange={(event) => setWriteFence(event.target.checked)}
                type="checkbox"
              />
              <span>
                {t(
                  'وردپرس در حالت نگهداری/فقط‌خواندنی است و سفارش یا محتوای تازه‌ای روی آن نوشته نمی‌شود.',
                  'WordPress is in maintenance/read-only mode and receives no new orders or content.',
                )}
              </span>
            </label>
            <div>
              <Button
                buttonStyle="secondary"
                disabled={!canManage || pending || !writeFence || Boolean(job.sourceWriteFenceConfirmedAt)}
                onClick={() =>
                  void post(
                    `/api/site/migration/job/${job.id}/write-fence`,
                    { confirmed: true, site: siteId },
                    t('توقف نوشتن روی وردپرس ثبت شد.', 'The WordPress write fence was recorded.'),
                  )
                }
              >
                {job.sourceWriteFenceConfirmedAt
                  ? t('حصار نوشتن تأیید شده است', 'Write fence confirmed')
                  : t('ثبت تأیید حصار نوشتن', 'Confirm write fence')}
              </Button>
            </div>
            <p>
              {t('شمارش این اجرا:', 'This run counts:')}{' '}
              {Object.entries(counts)
                .map(([key, value]) => `${key}: ${textOf(value)}`)
                .join(' · ') || '—'}
            </p>
            <p>
              {t('دفتر رکوردها:', 'Ledger:')}{' '}
              {Object.entries(view.recordCounts)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' · ')}
              {' · '}
              {t('تغییرمسیرها:', 'Redirects:')}{' '}
              {Object.entries(view.redirectCounts)
                .map(([key, value]) => `${key}: ${value}`)
                .join(' · ')}
            </p>
          </>
        ) : (
          <Banner type="info">{t('هنوز کار مهاجرتی ساخته نشده است.', 'No migration job exists yet.')}</Banner>
        )}
      </section>

      <section style={box}>
        <h2>{t('۴) پوشش، مانع‌ها و گزارش‌ها', '4) Coverage, blockers & reports')}</h2>
        {blockers.length > 0 && (
          <Banner type="error">
            <ul>
              {blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </Banner>
        )}
        {coverage.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  {[t('بخش', 'Resource'), t('مقصد', 'Destination'), t('تکلیف', 'Disposition'), t('دلیل', 'Reason')].map(
                    (head) => (
                      <th key={head} style={{ borderBottom: '1px solid var(--theme-elevation-150)', padding: '0.4rem', textAlign: 'start' }}>
                        {head}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {coverage.map((row, index) => (
                  <tr key={`${textOf(row.resource)}-${index}`}>
                    <td style={{ padding: '0.4rem' }}>{textOf(row.label ?? row.resource)}</td>
                    <td style={{ padding: '0.4rem' }}>{textOf(row.destination)}</td>
                    <td style={{ padding: '0.4rem' }}>{textOf(row.disposition)}</td>
                    <td style={{ padding: '0.4rem' }}>{textOf(row.reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>{t('پس از کشف مبدأ، ماتریس پوشش این‌جا دیده می‌شود.', 'Run discovery to see the coverage matrix.')}</p>
        )}

        {dryResources.length > 0 && (
          <>
            <h3>{t('نتیجه اجرای خشک', 'Dry-run result')}</h3>
            <ul>
              {dryResources.map((row) => (
                <li key={textOf(row.resource)}>
                  {textOf(row.resource)}: {t('دیده‌شده', 'seen')} {textOf(row.seen)} ·{' '}
                  {t('ساخته می‌شود', 'would create')} {textOf(row.wouldCreate)} ·{' '}
                  {t('به‌روز می‌شود', 'would update')} {textOf(row.wouldUpdate)} ·{' '}
                  {t('بی‌تغییر', 'unchanged')} {textOf(row.unchanged)} ·{' '}
                  {t('بایگانی', 'archived')} {textOf(row.archived)} · {t('مسدود', 'blocked')}{' '}
                  {textOf(row.blocked)}
                </li>
              ))}
            </ul>
          </>
        )}

        {Object.keys(reconciliation).length > 0 && (
          <p>
            {t('آخرین تطبیق:', 'Last reconciliation:')}{' '}
            {reconciliation.ok === true
              ? t('کامل و آماده برش', 'clean — ready for cutover')
              : t('ناهماهنگی مسدودکننده دارد', 'has blocking discrepancies')}
            {' · '}
            {textOf(reconciliation.checkedAt)}
          </p>
        )}

        {view.errors.length > 0 && (
          <>
            <h3>{t('خطاهای باز', 'Open errors')}</h3>
            <ul>
              {view.errors.map((item) => (
                <li key={item.id}>
                  <code>{textOf(item.code)}</code> {textOf(item.resource)}{' '}
                  {textOf(item.sourceRecordId)} — {textOf(item.message)}
                </li>
              ))}
            </ul>
          </>
        )}
        {view.audits.length > 0 && (
          <>
            <h3>{t('آخرین رویدادهای حسابرسی', 'Recent audit events')}</h3>
            <ul>
              {view.audits.slice(0, 10).map((item) => (
                <li key={item.id}>
                  {textOf(item.createdAt)} — {textOf(item.summary)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

export default MigrationCenterForm
