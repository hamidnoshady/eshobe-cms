import React from 'react'

import type { DocumentViewServerProps, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { formatDate, formatNumber } from '@/lib/format'
import { locales } from '@/lib/locales'
import { billingStatusForSite } from '@/billing/health'
import { siteReportFor } from '@/platform/report'

/**
 * The Customer-360 pane: «نمای ۳۶۰» on a site document —
 * `/admin/collections/sites/:id/overview`.
 *
 * Task §4 asks for a single screen where an operator sees everything about one
 * customer without opening six collections. This is that screen, and it is *only*
 * composition: every number, domain, locale and gateway on it comes from
 * `siteReportFor` — the same function `GET /api/platform/sites/:id` returns and
 * that `platform-control.int.spec.ts` already tests. No new query, no new backend,
 * nothing this view knows that the API does not.
 *
 * A server component, like `OperatorDashboard` and `DeploymentView`: the report runs
 * on the server with the operator's own request, so there is no client fetch, no
 * loading state and no second auth path. The `isPlatformAdmin` check here is UX — it
 * keeps a customer's own staff (who see their site in this collection to read their
 * domain status) from seeing the operator pane. It is not the boundary: `siteReportFor`
 * runs `overrideAccess: true` on a request already proven to be an operator's, and the
 * report exposes only counts, hostnames, booleans and gateway ids — never a secret,
 * never a credential, never a Coolify identifier.
 */

const card = (accent: string): React.CSSProperties => ({
  background: 'var(--theme-elevation-50)',
  border: '1px solid var(--theme-elevation-100)',
  borderInlineStartColor: accent,
  borderInlineStartWidth: '3px',
  borderRadius: 'var(--style-radius-m, 6px)',
  display: 'flex',
  flexDirection: 'column',
  gap: '.25rem',
  minWidth: 0,
  padding: '.9rem 1rem',
})

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gap: '.75rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
}

const valueStyle: React.CSSProperties = { fontSize: '1.6rem', fontWeight: 600, lineHeight: 1.2 }
const labelStyle: React.CSSProperties = { color: 'var(--theme-elevation-600)', fontSize: '.8rem' }
const noteStyle: React.CSSProperties = { color: 'var(--theme-elevation-500)', fontSize: '.75rem' }

const fa = (value: number): string => formatNumber(value, 'fa')

const localeLabel = (code: string): string => locales.find((l) => l.code === code)?.label ?? code

const STATUS_LABEL: Record<string, string> = {
  active: 'فعال',
  archived: 'بایگانی‌شده',
  suspended: 'معلق',
}

const STATUS_ACCENT: Record<string, string> = {
  active: 'var(--theme-success-500)',
  archived: 'var(--theme-elevation-400)',
  suspended: 'var(--theme-warning-500)',
}

const SELF_TEST_LABEL: Record<'failed' | 'ok', string> = {
  failed: 'خودآزمون ناموفق',
  ok: 'خودآزمون موفق',
}

const Stat: React.FC<{
  accent?: string
  label: string
  note?: string
  value: number | string
}> = ({ accent = 'var(--theme-elevation-200)', label, note, value }) => (
  <div style={card(accent)}>
    <span style={valueStyle}>{typeof value === 'number' ? fa(value) : value}</span>
    <span style={labelStyle}>{label}</span>
    {note ? <span style={noteStyle}>{note}</span> : null}
  </div>
)

const Section: React.FC<{ children: React.ReactNode; title: string }> = ({ children, title }) => (
  <section style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
    <h3 style={{ fontSize: '.95rem', margin: 0 }}>{title}</h3>
    <div style={gridStyle}>{children}</div>
  </section>
)

const pill = (ok: boolean): React.CSSProperties => ({
  background: ok ? 'var(--theme-success-100)' : 'var(--theme-warning-100)',
  borderRadius: '999px',
  color: ok ? 'var(--theme-success-700)' : 'var(--theme-warning-700)',
  fontSize: '.72rem',
  padding: '.1rem .5rem',
  whiteSpace: 'nowrap',
})

export const SiteOverviewView: React.FC<DocumentViewServerProps> = async ({ doc, initPageResult }) => {
  const req = initPageResult?.req as PayloadRequest | undefined
  const user = req?.user

  if (!isPlatformAdmin(user)) {
    return (
      <div className="banner banner--type-error">
        نمای ۳۶۰ مشتری فقط برای کارکنان سکو در دسترس است.
      </div>
    )
  }

  const site = (doc ?? {}) as Record<string, unknown>
  const siteId = site.id ? String(site.id) : ''

  if (!siteId || !req) {
    return (
      <div className="banner banner--type-default">
        ابتدا سایت را ذخیره کنید تا نمای ۳۶۰ آن ساخته شود.
      </div>
    )
  }

  let report: Awaited<ReturnType<typeof siteReportFor>>
  try {
    report = await siteReportFor(req, site)
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'customer-360 report failed', siteId })
    return (
      <div className="banner banner--type-error">
        گزارش این مشتری بارگذاری نشد. جزئیات در لاگ سرور است؛ بقیهٔ سند سالم است.
      </div>
    )
  }

  let billing: Awaited<ReturnType<typeof billingStatusForSite>> | null = null
  try {
    billing = await billingStatusForSite(req, siteId)
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: 'customer-360 billing status failed', siteId })
  }

  const t = report.totals
  const statusLabel = STATUS_LABEL[report.status] ?? report.status
  const statusAccent = STATUS_ACCENT[report.status] ?? 'var(--theme-elevation-400)'
  const unverifiedAliases = report.aliases.filter((a) => !a.verified)
  const failingGateways = report.gateways.filter((g) => g.enabled && g.selfTest === 'failed')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', padding: '2rem' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        <h2 style={{ margin: 0 }}>نمای ۳۶۰ مشتری — {report.name}</h2>
        <p style={{ color: 'var(--theme-elevation-600)', margin: 0 }}>
          گزارش عملیاتی از <code>GET /api/platform/sites/{siteId}</code> می‌آید. وضعیت تجاری فقط‌خواندنی
          است و از <code>GET /api/platform/sites/{siteId}/billing</code> — قیمت و صورتحساب اینجا ویرایش نمی‌شود.
        </p>
      </header>

      {report.status !== 'active' ? (
        <div className="banner banner--type-warning">
          وضعیت این سایت «{statusLabel}» است؛ ممکن است برای مشتری در دسترس نباشد.
        </div>
      ) : null}
      {!report.domainVerified ? (
        <div className="banner banner--type-warning">
          دامنهٔ اصلی «{report.domain}» هنوز تأیید نشده است.
        </div>
      ) : null}
      {failingGateways.length ? (
        <div className="banner banner--type-warning">
          {`${fa(failingGateways.length)} درگاه پرداخت فعال، خودآزمون را رد کرده است.`}
        </div>
      ) : null}

      {report.deployment.updateAvailable ? (
        <div className="banner banner--type-info" role="status">
          نسخهٔ جدید پوسته موجود است — در حال اجرا{' '}
          <code dir="ltr">{report.deployment.activeCommit?.slice(0, 8) ?? '—'}</code> و آخرین همگام‌سازی{' '}
          <code dir="ltr">{report.deployment.updateLatestCommit?.slice(0, 8) ?? '—'}</code> را نشان می‌دهد.
          جزئیات و اقدام‌ها در تب «استقرار پوسته».
        </div>
      ) : null}
      {report.deployment.needsRedeploy ? (
        <div className="banner banner--type-warning" role="alert">
          دامنهٔ سایت پس از استقرار فعلی تغییر کرده است. پوسته را از تب «استقرار پوسته» مجدداً مستقر کنید.
        </div>
      ) : null}

      <Section title="وضعیت تجاری">
        <Stat label="مرجع" value="پلتفرم اشوب" note="طرح و قیمت اینجا ویرایش نمی‌شود." />
        <Stat label="کد طرح" value={billing?.planCode || '—'} />
        <Stat label="نسخهٔ تصویر" value={billing?.projectionVersion ?? '—'} />
        <Stat
          accent={billing?.serving ? 'var(--theme-success-500)' : 'var(--theme-warning-500)'}
          label="سرویس تجاری"
          note={billing?.subscriptionStatus ?? 'تعویق پرداخت به‌تنهایی سایت را معلق نمی‌کند.'}
          value={billing?.serving ? 'در حال سرویس' : 'خارج از سرویس'}
        />
        <Stat
          label="آخرین همگام‌سازی"
          value={billing?.receivedAt ? formatDate(billing.receivedAt, 'fa') : '—'}
        />
        <Stat label="مصرف ارسال‌نشده" value={billing?.unsentUsage ?? '—'} />
      </Section>

      <Section title="پوسته و استقرار">
        <Stat
          accent={report.deployment.renderedBy === 'deployment' ? 'var(--theme-success-500)' : 'var(--theme-elevation-200)'}
          label="رندرکننده"
          note={
            report.deployment.renderedBy === 'deployment'
              ? report.deployment.activePackageName ?? 'پوستهٔ مستقر'
              : 'رندرکنندهٔ داخلی'
          }
          value={report.deployment.renderedBy === 'deployment' ? 'پوستهٔ خارجی' : 'داخلی'}
        />
        <Stat
          label="کامیت فعال"
          note={report.deployment.repository ? `مخزن: ${report.deployment.repository}` : undefined}
          value={report.deployment.activeCommit ? report.deployment.activeCommit.slice(0, 8) : '—'}
        />
        <Stat
          label="پیش‌نمایش"
          note={report.deployment.previewStatus ?? undefined}
          value={report.deployment.previewOpenUrl ? 'در دسترس' : '—'}
        />
        <Stat
          label="حالت دامنه"
          value={report.deployment.domainMode ?? '—'}
        />
      </Section>

      {report.deployment.previewOpenUrl ? (
        <p style={{ margin: 0 }}>
          <a href={report.deployment.previewOpenUrl} rel="noopener noreferrer" target="_blank">
            باز کردن پیش‌نمایش
          </a>
          {' '}
          (<code dir="ltr">{report.deployment.previewOpenUrl}</code>)
        </p>
      ) : null}

      <Section title="شناسه و وضعیت">
        <Stat accent={statusAccent} label="وضعیت" value={statusLabel} />
        <Stat label="نوع سایت" value={report.type} />
        <Stat
          label="دامنهٔ اصلی"
          note={report.domainVerified ? 'تأیید‌شده' : 'تأیید‌نشده'}
          value={report.domain || '—'}
        />
        <Stat label="ساخته‌شده" value={report.createdAt ? formatDate(report.createdAt, 'fa') : '—'} />
        <Stat
          label="آخرین به‌روزرسانی"
          value={report.updatedAt ? formatDate(report.updatedAt, 'fa') : '—'}
        />
      </Section>

      <Section title="محتوا">
        <Stat label="برگه‌ها" note={`${fa(t.pagesPublished)} منتشرشده`} value={t.pages} />
        <Stat label="نوشته‌ها" note={`${fa(t.postsPublished)} منتشرشده`} value={t.posts} />
        <Stat label="محصولات" note={`${fa(t.productsPublished)} منتشرشده`} value={t.products} />
        <Stat label="دسته‌بندی‌ها" value={t.categories} />
        <Stat label="رسانه" value={t.media} />
      </Section>

      <Section title="فروشگاه">
        <Stat label="سفارش‌ها" note={`${fa(t.ordersPaid)} پرداخت‌شده`} value={t.orders} />
        <Stat label="واحد پول" value={report.currency ?? '—'} />
        <Stat
          accent={failingGateways.length ? 'var(--theme-warning-500)' : 'var(--theme-elevation-200)'}
          label="درگاه‌های پرداخت"
          note={report.gateways.length ? `${fa(report.gateways.filter((g) => g.enabled).length)} فعال` : 'بدون درگاه'}
          value={report.gateways.length}
        />
      </Section>

      {report.gateways.length ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          <h3 style={{ fontSize: '.95rem', margin: 0 }}>وضعیت درگاه‌ها</h3>
          <ul style={{ display: 'flex', flexDirection: 'column', gap: '.3rem', listStyle: 'none', margin: 0, padding: 0 }}>
            {report.gateways.map((g) => (
              <li key={g.gateway} style={{ alignItems: 'center', display: 'flex', gap: '.5rem' }}>
                <code>{g.gateway}</code>
                <span style={pill(g.enabled)}>{g.enabled ? 'فعال' : 'غیرفعال'}</span>
                <span style={noteStyle}>
                  {g.selfTest ? SELF_TEST_LABEL[g.selfTest] : 'خودآزمون انجام‌نشده'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
        <h3 style={{ fontSize: '.95rem', margin: 0 }}>دامنه‌ها و زبان‌ها</h3>
        <p style={{ color: 'var(--theme-elevation-600)', fontSize: '.85rem', margin: 0 }}>
          زبان‌ها: {report.availableLocales.length
            ? report.availableLocales.map(localeLabel).join(' · ')
            : localeLabel(report.defaultLocale ?? 'fa')}
          {report.defaultLocale ? `  (پیش‌فرض: ${localeLabel(report.defaultLocale)})` : ''}
        </p>
        {report.aliases.length ? (
          <ul style={{ display: 'flex', flexDirection: 'column', gap: '.3rem', listStyle: 'none', margin: 0, padding: 0 }}>
            {report.aliases.map((a) => (
              <li key={a.hostname} style={{ alignItems: 'center', display: 'flex', gap: '.5rem' }}>
                <code>{a.hostname}</code>
                <span style={pill(a.verified)}>{a.verified ? 'تأیید‌شده' : 'تأیید‌نشده'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: 'var(--theme-elevation-500)', fontSize: '.8rem', margin: 0 }}>
            نشانی فرعی‌ای ثبت نشده است.
          </p>
        )}
        {unverifiedAliases.length ? (
          <p style={{ color: 'var(--theme-elevation-500)', fontSize: '.75rem', margin: 0 }}>
            {`${fa(unverifiedAliases.length)} نشانی فرعی هنوز تأیید نشده است.`}
          </p>
        ) : null}
      </section>
    </div>
  )
}

export default SiteOverviewView
