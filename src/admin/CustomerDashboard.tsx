import React from 'react'

import type { PayloadRequest, ServerProps } from 'payload'

import type { Site } from '@/payload-types'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { formatNumber } from '@/lib/format'
import { storeOverview, type StoreOverview } from '@/lib/storeOverview'

import { collection, createHref, entityHref } from './navigation'
import {
  CUSTOMER_QUICK_ACTIONS,
  CUSTOMER_STAT_LINKS,
  CUSTOMER_STAT_SLUGS,
  type DashboardStat,
} from './dashboardLinks'

/**
 * What a customer's staff see when they open `/admin`.
 *
 * Payload's stock dashboard is a grid of collection counts, which is close to
 * right for a customer — but it lists every collection flatly and offers no way
 * *in*. This puts their site's status and the six actions they actually take
 * (create a page, a post, upload media, add a product, edit navigation, view the
 * live site) above it, and renders nothing at all for a platform operator, whose
 * front page is `OperatorDashboard`.
 *
 * A server component so the counts run tenant-scoped on the customer's own
 * request — the multi-tenant plugin narrows every `find`/`count` here to the
 * site(s) this user belongs to, so no number can cross a tenant boundary. Every
 * card links to the canonical screen; nothing here stores its own data.
 */

type Props = Partial<ServerProps>

const fa = (value: number): string => formatNumber(value, 'fa')

const card: React.CSSProperties = {
  background: 'var(--theme-elevation-50)',
  border: '1px solid var(--theme-elevation-100)',
  borderRadius: 'var(--style-radius-m, 6px)',
  display: 'flex',
  flexDirection: 'column',
  gap: '.25rem',
  minWidth: 0,
  padding: '.9rem 1rem',
}

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gap: '.75rem',
  gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))',
}

const valueStyle: React.CSSProperties = { fontSize: '1.6rem', fontWeight: 600, lineHeight: 1.2 }
const labelStyle: React.CSSProperties = { color: 'var(--theme-elevation-600)', fontSize: '.8rem' }

const StatLink: React.FC<{ href: string; label: string; value: number | string }> = ({
  href,
  label,
  value,
}) => (
  <a style={{ ...card, textDecoration: 'none', color: 'inherit' }} href={href}>
    <span style={valueStyle}>{typeof value === 'number' ? fa(value) : value}</span>
    <span style={labelStyle}>{label}</span>
  </a>
)

const Action: React.FC<{ href: string; label: string; external?: boolean }> = ({
  external,
  href,
  label,
}) => (
  <a
    className="btn btn--style-secondary btn--size-small"
    href={href}
    rel={external ? 'noreferrer' : undefined}
    style={{ margin: 0 }}
    target={external ? '_blank' : undefined}
  >
    {label}
  </a>
)

const Section: React.FC<{ children: React.ReactNode; title: string }> = ({ children, title }) => (
  <section style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
    <h3 style={{ fontSize: '.95rem', margin: 0 }}>{title}</h3>
    <div style={gridStyle}>{children}</div>
  </section>
)

const CustomerDashboard: React.FC<Props> = async ({ payload, user }) => {
  // Platform operators get `OperatorDashboard`, not this one.
  if (!payload || isPlatformAdmin(user)) return null

  const adminRoute = payload.config.routes?.admin ?? '/admin'
  const req = { context: {}, payload, user } as unknown as PayloadRequest

  // Tenant-scoped: the multi-tenant plugin narrows each of these to the caller's
  // own site(s). A failure here must not blank the front page.
  let site: Site | null = null
  const counts: Record<string, number> = {}

  try {
    // `overrideAccess: false` scopes every read to the caller's own site(s). The
    // Local API defaults to `overrideAccess: true`, which SKIPS the multi-tenant
    // plugin's read constraint — so without this a customer's dashboard would show
    // the platform-wide count across every tenant, and pick some other customer's
    // site for the header. Same rule as `src/lib/site-query.ts`.
    const sites = await payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      req,
    })
    site = sites.docs[0] ?? null

    const results = await Promise.all(
      CUSTOMER_STAT_SLUGS.map(async (slug) => {
        try {
          const { totalDocs } = await payload.count({
            collection: slug as Parameters<typeof payload.count>[0]['collection'],
            overrideAccess: false,
            req,
          })
          return [slug, totalDocs] as const
        } catch {
          return [slug, 0] as const
        }
      }),
    )
    for (const [slug, total] of results) counts[slug] = total
  } catch (error) {
    payload.logger.error({ err: error as Error, msg: 'customer dashboard load failed' })
  }

  // Store control-centre summary — only for a `store` site, and tenant-scoped by
  // `storeOverview` itself. A failure must not blank the rest of the page.
  let store: StoreOverview | null = null
  if (site?.type === 'store') {
    try {
      store = await storeOverview(req)
    } catch (error) {
      payload.logger.error({ err: error as Error, msg: 'store overview load failed' })
    }
  }

  // Things that need the customer's attention, most urgent first.
  const warnings: string[] = []
  if (site?.domain && !site.domainVerified) {
    warnings.push('دامنهٔ شما هنوز تأیید نشده است؛ تا تأیید DNS، گواهی TLS صادر نمی‌شود.')
  }
  if (store) {
    if (store.products.outOfStock > 0) {
      warnings.push(`${fa(store.products.outOfStock)} محصول ناموجود است.`)
    }
    if (store.products.lowStock > 0) {
      warnings.push(`${fa(store.products.lowStock)} محصول رو به اتمام است.`)
    }
    if (store.payments.configured === 0) {
      warnings.push('هیچ درگاه پرداختی پیکربندی نشده است؛ سفارش‌ها قابل پرداخت نیستند.')
    } else if (store.payments.needsAttention > 0) {
      warnings.push(`${fa(store.payments.needsAttention)} درگاه پرداخت فعال، آزمایش اتصال ناموفق دارد.`)
    }
  }

  const ordersHref = entityHref(adminRoute, collection('orders'))
  const productsHref = entityHref(adminRoute, collection('products'))
  const siteUrl = site?.domain ? `https://${site.domain}` : null
  const statusLabel = site?.domainVerified
    ? 'دامنه تأییدشده'
    : site?.domain
      ? 'در انتظار تأیید دامنه'
      : 'دامنه‌ای ثبت نشده'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginBottom: '2rem' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        <h2 style={{ margin: 0 }}>{site?.name ? `مدیریت ${site.name}` : 'مدیریت سایت'}</h2>
        <p style={{ color: 'var(--theme-elevation-600)', margin: 0 }}>
          {site?.domain ? `${site.domain} — ${statusLabel}` : statusLabel}
        </p>
      </header>

      {warnings.length > 0 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          {warnings.map((warning) => (
            <div className="banner banner--type-warning" key={warning} style={{ margin: 0 }}>
              {warning}
            </div>
          ))}
        </section>
      ) : null}

      <Section title="دسترسی سریع">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
          {CUSTOMER_QUICK_ACTIONS.map((action) => (
            <Action
              href={
                action.create
                  ? createHref(adminRoute, action.entity.slug)
                  : entityHref(adminRoute, action.entity)
              }
              key={`${action.entity.slug}-${action.create ? 'create' : 'edit'}`}
              label={action.label}
            />
          ))}
          {siteUrl ? <Action external href={siteUrl} label="مشاهدهٔ سایت" /> : null}
        </div>
      </Section>

      <Section title="یک نگاه به سایت">
        {CUSTOMER_STAT_LINKS.map((stat: DashboardStat) => (
          <StatLink
            href={entityHref(adminRoute, stat.entity)}
            key={stat.entity.slug}
            label={stat.label}
            value={counts[stat.entity.slug] ?? 0}
          />
        ))}
      </Section>

      {store ? (
        <Section title="فروشگاه">
          <StatLink
            href={ordersHref}
            label="سفارش‌های در انتظار پرداخت"
            value={store.orders.pending}
          />
          <StatLink href={ordersHref} label="سفارش‌های پرداخت‌شده" value={store.orders.paid} />
          <StatLink href={productsHref} label="محصولات منتشرشده" value={store.products.published} />
          <StatLink href={productsHref} label="رو به اتمام" value={store.products.lowStock} />
          <StatLink href={productsHref} label="ناموجود" value={store.products.outOfStock} />
        </Section>
      ) : null}
    </div>
  )
}

export default CustomerDashboard
