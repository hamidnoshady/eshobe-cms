import React from 'react'

import type { PayloadRequest, ServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { formatDate, formatNumber } from '@/lib/format'
import { saasOverview } from '@/platform/saas-report'
import { platformOverview } from '@/platform/report'

/**
 * What a platform operator sees when they open `/admin`.
 *
 * Payload's dashboard is a grid of collection cards — "برگه‌ها: ۲۴". For a customer
 * editing their own website that is exactly right. For the operator of a SaaS it is
 * the wrong screen entirely: the number it shows is the sum across every customer,
 * which is a figure nobody has ever needed, and the six things that actually run
 * the business (who is past due, whose domain is unverified, which webhook is dead,
 * is storage working) are not on it at all.
 *
 * So this renders `beforeDashboard`, for platform admins only, and it is a *report*
 * — every number here is a count this deployment already computes for
 * `GET /api/platform/overview` and `GET /api/platform/saas/overview`. Deliberately
 * the same two functions, not a parallel set of queries: a dashboard that disagrees
 * with the API is worse than no dashboard, and this way the API is exercised by
 * every page load an operator makes.
 *
 * A server component, so the reports run on the server with the operator's own
 * request — no client fetch, no loading state, no second auth path.
 */

type Props = Partial<ServerProps>

// Every rendered number goes through `formatNumber` (CLAUDE.md) — this panel is
// Persian-only, and `fa` there means Persian digits and a Jalali calendar.
const fa = (value: number): string => formatNumber(value, 'fa')

const Stat: React.FC<{
  accent?: string
  label: string
  note?: string
  value: number | string
}> = ({ accent = 'var(--theme-elevation-200)', label, note, value }) => (
  <div
    className="eshobe-card"
    style={{ borderInlineStartColor: accent, borderInlineStartWidth: '3px' }}
  >
    <span className="eshobe-card__value">{typeof value === 'number' ? fa(value) : value}</span>
    <span className="eshobe-card__label">{label}</span>
    {note ? <span className="eshobe-card__note">{note}</span> : null}
  </div>
)

const Section: React.FC<{ children: React.ReactNode; title: string }> = ({ children, title }) => (
  <section style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
    <h3 style={{ fontSize: '.95rem', margin: 0 }}>{title}</h3>
    <div className="eshobe-grid">{children}</div>
  </section>
)

/** Money in minor units, one line per currency — never summed across them. */
const OperatorDashboard: React.FC<Props> = async ({ payload, user }) => {
  // Not an access boundary — every underlying collection is `platformAdmin` on
  // `read`, and the reports run with `overrideAccess` on the operator's own request.
  // This is what keeps a customer's dashboard unchanged.
  if (!isPlatformAdmin(user) || !payload) return null

  const req = { context: {}, payload, user } as unknown as PayloadRequest

  let fleet: Awaited<ReturnType<typeof platformOverview>> | null = null
  let saas: Awaited<ReturnType<typeof saasOverview>> | null = null

  try {
    ;[fleet, saas] = await Promise.all([platformOverview(req), saasOverview(req)])
  } catch (error) {
    // A report that fails must not take the admin's front page with it — an
    // operator who cannot open `/admin` cannot fix whatever broke the report.
    payload.logger.error({ err: error as Error, msg: 'operator dashboard report failed' })
    return (
      <div className="banner banner--type-error">
        گزارش سکو بارگذاری نشد. جزئیات در لاگ سرور است؛ بقیهٔ پنل کار می‌کند.
      </div>
    )
  }

  const unverified = fleet.sites.unverified
  const failingWebhooks = saas.operations.webhooks.failing
  const outboxBacklog = saas.billing.outboxPending + saas.billing.outboxFailed + saas.billing.outboxSending
  const storageUsable = fleet.infrastructure.storage.usable

  return (
    <div className="eshobe-stack">
      <header style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        <h2 style={{ margin: 0 }}>کنسول مدیریت سکو</h2>
        <p style={{ color: 'var(--theme-elevation-600)', margin: 0 }}>
          این پنل، سرویس را اداره می‌کند نه محتوای مشتری‌ها را. همین اعداد از{' '}
          <code>/api/platform/overview</code> و <code>/api/platform/saas/overview</code> هم برای
          برنامه‌های دیگر برگردانده می‌شوند.
        </p>
      </header>

      {saas.operations.maintenanceMode ? (
        <div className="banner banner--type-error">
          حالت تعمیر روشن است — برنامه‌های متصل این وضعیت را از API می‌خوانند و تغییرات را متوقف می‌کنند.
        </div>
      ) : null}

      <Section title="ناوگان سایت‌ها">
        <Stat label="کل سایت‌ها" value={fleet.sites.total} />
        <Stat
          accent={unverified ? 'var(--theme-warning-500)' : 'var(--theme-success-500)'}
          label="دامنهٔ تأییدنشده"
          note={unverified ? 'تا تأیید DNS، گواهی TLS صادر نمی‌شود.' : 'همهٔ دامنه‌ها تأیید شده‌اند.'}
          value={unverified}
        />
        <Stat label="فعال" value={fleet.sites.byStatus.active ?? 0} />
        <Stat label="معلق" value={fleet.sites.byStatus.suspended ?? 0} />
      </Section>

      <Section title="صورت‌حساب مرکزی">
        <Stat label="مرجع تجاری" value="پلتفرم اشوب" note="قیمت و صورتحساب اینجا محاسبه نمی‌شود." />
        <Stat
          accent={outboxBacklog ? 'var(--theme-warning-500)' : 'var(--theme-success-500)'}
          label="صف ارسال مصرف"
          note={saas.billing.oldestPendingAt ? `قدیمی‌ترین: ${formatDate(saas.billing.oldestPendingAt, 'fa', { dateStyle: 'medium', timeStyle: 'short' })}` : 'صف خالی است.'}
          value={outboxBacklog}
        />
        <Stat
          accent={saas.billing.deadLetters ? 'var(--theme-error-500)' : undefined}
          label="رویداد بن‌بست"
          value={saas.billing.deadLetters}
        />
        <Stat
          label="آخرین ارسال موفق"
          value={saas.billing.lastSuccessfulPublishAt ? 'ثبت شده' : 'هنوز نه'}
          note={
            saas.billing.lastSuccessfulPublishAt
              ? formatDate(saas.billing.lastSuccessfulPublishAt, 'fa', { dateStyle: 'medium', timeStyle: 'short' })
              : undefined
          }
        />
        <Stat
          label="سایت بدون تصویر حق‌دسترسی"
          value={saas.billing.sitesWithoutProjection ?? '—'}
        />
      </Section>

      <Section title="زیرساخت">
        <Stat
          accent={storageUsable ? 'var(--theme-success-500)' : 'var(--theme-error-500)'}
          label="ذخیره‌سازی اشیا"
          note={
            storageUsable
              ? String(fleet.infrastructure.storage.bucket ?? '')
              : fleet.infrastructure.storage.enabled
                ? 'فعال است ولی کلیدش باز نمی‌شود.'
                : 'اتصالی فعال نیست — فایل‌ها روی دیسک محلی می‌مانند.'
          }
          value={storageUsable ? 'سالم' : 'نیاز به رسیدگی'}
        />
        <Stat
          accent={fleet.infrastructure.jobs.failed ? 'var(--theme-warning-500)' : undefined}
          label="صف کارها"
          note={`${fa(fleet.infrastructure.jobs.queued)} در صف · ${fa(fleet.infrastructure.jobs.failed)} ناموفق`}
          value={fleet.infrastructure.jobs.available ? 'در دسترس' : 'در دسترس نیست'}
        />
        <Stat label="zoneهای CDN" value={fleet.infrastructure.cdnZones} />
        <Stat
          label="کلیدهای API"
          note={`${fa(fleet.infrastructure.keys.disabled)} باطل‌شده`}
          value={fleet.infrastructure.keys.total}
        />
      </Section>

      <Section title="افزونه‌ها و عملیات">
        <Stat
          label="افزونهٔ فعال"
          note={`از ${fa(saas.extensions.plugins.total)} نصب‌شده`}
          value={saas.extensions.plugins.enabled}
        />
        <Stat label="پوستهٔ آماده" value={saas.extensions.themes} />
        <Stat
          accent={failingWebhooks ? 'var(--theme-error-500)' : undefined}
          label="وب‌هوک خطادار"
          note={`${fa(saas.operations.webhooks.enabled)} فعال`}
          value={failingWebhooks}
        />
        <Stat
          label="سیاست سقف‌ها"
          note={
            saas.operations.quotaEnforcement === 'enforce'
              ? 'ساخت مورد جدید پس از سقف رد می‌شود.'
              : saas.operations.quotaEnforcement === 'off'
                ? 'هیچ سقفی اعمال نمی‌شود.'
                : 'فقط گزارش می‌شود؛ جلوی کار گرفته نمی‌شود.'
          }
          value={
            saas.operations.quotaEnforcement === 'enforce'
              ? 'سخت‌گیرانه'
              : saas.operations.quotaEnforcement === 'off'
                ? 'خاموش'
                : 'هشدار'
          }
        />
      </Section>
    </div>
  )
}

export default OperatorDashboard
