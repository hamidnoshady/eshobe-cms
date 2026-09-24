import React from 'react'

import type { PayloadRequest, ServerProps } from 'payload'

import type { Site } from '@/payload-types'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { formatNumber } from '@/lib/format'

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
  const base = adminRoute === '/' ? '' : adminRoute
  const req = { context: {}, payload, user } as unknown as PayloadRequest

  // Tenant-scoped: the multi-tenant plugin narrows each of these to the caller's
  // own site(s). A failure here must not blank the front page.
  let site: Site | null = null
  const counts: Record<string, number> = {}

  try {
    const sites = await payload.find({ collection: 'sites', depth: 0, limit: 1, req })
    site = sites.docs[0] ?? null

    const countable = ['pages', 'posts', 'products', 'orders', 'form-submissions'] as const
    const results = await Promise.all(
      countable.map(async (slug) => {
        try {
          const { totalDocs } = await payload.count({ collection: slug, req })
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

      <Section title="دسترسی سریع">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
          <Action href={`${base}/collections/pages/create`} label="ساخت برگه" />
          <Action href={`${base}/collections/posts/create`} label="ساخت نوشته" />
          <Action href={`${base}/collections/media/create`} label="بارگذاری رسانه" />
          <Action href={`${base}/collections/products/create`} label="افزودن محصول" />
          <Action href={`${base}/globals/header`} label="ویرایش پیمایش" />
          {siteUrl ? <Action external href={siteUrl} label="مشاهدهٔ سایت" /> : null}
        </div>
      </Section>

      <Section title="یک نگاه به سایت">
        <StatLink href={`${base}/collections/pages`} label="برگه‌ها" value={counts.pages ?? 0} />
        <StatLink href={`${base}/collections/posts`} label="نوشته‌ها" value={counts.posts ?? 0} />
        <StatLink href={`${base}/collections/products`} label="محصولات" value={counts.products ?? 0} />
        <StatLink href={`${base}/collections/orders`} label="سفارش‌ها" value={counts.orders ?? 0} />
        <StatLink
          href={`${base}/collections/form-submissions`}
          label="پاسخ‌های فرم"
          value={counts['form-submissions'] ?? 0}
        />
      </Section>
    </div>
  )
}

export default CustomerDashboard
