import React from 'react'

import type { PayloadRequest, ServerProps } from 'payload'

import type { Site } from '@/payload-types'
import { deployOrigin } from '@/lib/deploy/previewUrl'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { customerSiteSummary } from '@/lib/customerSiteSummary'
import { formatNumber } from '@/lib/format'
import { locales } from '@/lib/locales'
import { storeOverview, type StoreOverview } from '@/lib/storeOverview'

import { siteStaffRole, themeSettingsView } from '@/deploy/tenantSettings'
import { isShopSite, SHOP_COLLECTIONS } from '@/lib/siteKind'
import { buildSlotRow, SLOT_COLLECTION, type ThemeSlotRow } from '@/lib/themeSlotLinks'

import { adminBase, collection, createHref, CUSTOMER_NAV, entityHref } from './navigation'
import {
  CUSTOMER_STAT_SLUGS,
  quickActionsFor,
  statLinksFor,
  type DashboardStat,
} from './dashboardLinks'

/**
 * What a customer's staff see when they open `/admin`.
 *
 * Payload's stock dashboard is a grid of collection counts, which lists every
 * collection flatly, offers no way *in*, and shows a portfolio the products and
 * orders it does not have. So a customer's front page is this instead: the site's
 * status, the actions they actually take, what the theme asked them to choose, and
 * the sections of the panel — all **by site type**. A shop gets orders, stock and
 * payments; every other site gets its content and its theme. `defaultLayout` in
 * `payload.config.ts` drops the stock grid for customers so the two do not stack.
 * It renders nothing at all for a platform operator, whose front page is
 * `OperatorDashboard`.
 *
 * A server component so the counts run tenant-scoped on the customer's own
 * request — the multi-tenant plugin narrows every `find`/`count` here to the
 * site(s) this user belongs to, so no number can cross a tenant boundary. Every
 * card links to the canonical screen; nothing here stores its own data.
 */

type Props = Partial<ServerProps>

const fa = (value: number): string => formatNumber(value, 'fa')

const StatLink: React.FC<{ href: string; label: string; value: number | string }> = ({
  href,
  label,
  value,
}) => (
  <a className="eshobe-card" href={href}>
    <span className="eshobe-card__value">{typeof value === 'number' ? fa(value) : value}</span>
    <span className="eshobe-card__label">{label}</span>
  </a>
)

const Action: React.FC<{ external?: boolean; href: string; label: string; primary?: boolean }> = ({
  external,
  href,
  label,
  primary,
}) => (
  <a
    className={`eshobe-action${primary ? ' eshobe-action--primary' : ''}`}
    href={href}
    rel={external ? 'noreferrer' : undefined}
    target={external ? '_blank' : undefined}
  >
    {label}
  </a>
)

const Section: React.FC<{ children: React.ReactNode; title: string }> = ({ children, title }) => (
  <section className="eshobe-section">
    <h3 className="eshobe-section__title">{title}</h3>
    {children}
  </section>
)

const Chip: React.FC<{ children: React.ReactNode; tone?: 'ok' | 'warn' }> = ({ children, tone }) => (
  <span className={`eshobe-chip${tone ? ` eshobe-chip--${tone}` : ''}`}>{children}</span>
)

const SLOT_STATE_LABEL: Record<ThemeSlotRow['state'], string> = {
  bound: 'متصل',
  missing: 'حذف‌شده',
  unbound: 'انتخاب نشده',
}

const CustomerDashboard: React.FC<Props> = async ({ payload, permissions, user }) => {
  // Platform operators get `OperatorDashboard`, not this one.
  if (!payload || isPlatformAdmin(user)) return null

  const adminRoute = payload.config.routes?.admin ?? '/admin'
  const req = { context: {}, payload, user } as unknown as PayloadRequest

  // Tenant-scoped (see `customerSiteSummary`): the multi-tenant plugin narrows each
  // read to the caller's own site(s). A failure here must not blank the front page.
  let site: Site | null = null
  let counts: Record<string, number> = {}

  try {
    const summary = await customerSiteSummary(req, CUSTOMER_STAT_SLUGS)
    site = summary.site
    counts = summary.counts
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

  // What the deployed theme asked the customer to choose (pages, categories, media…),
  // straight from its manifest — so a slot a theme adds later appears with no CMS change.
  // Tenant-scoped reads; a failure leaves the section out rather than blanking the page.
  let theme: { name: string; rows: ThemeSlotRow[] } | null = null
  const themeSettingsHref = site
    ? `${adminBase(adminRoute)}/collections/sites/${encodeURIComponent(String(site.id))}/theme-settings`
    : null
  if (site && themeSettingsHref) {
    try {
      const view = await themeSettingsView(req, String(site.id), siteStaffRole(user, String(site.id)))
      if (view.package) {
        const rows = await Promise.all(
          view.contentSlots.map(async (slot) => {
            const binding = view.bindings[slot.key]
            const id =
              binding && typeof binding === 'object'
                ? String((binding as { id?: unknown }).id ?? '')
                : ''
            let doc: null | Record<string, unknown> = null
            if (id) {
              doc = (await payload.findByID({
                collection: SLOT_COLLECTION[slot.type] as 'pages',
                depth: 0,
                disableErrors: true,
                id,
                overrideAccess: false,
                req,
                select: { filename: true, title: true },
              })) as unknown as null | Record<string, unknown>
            }
            return buildSlotRow({ adminRoute, binding, doc, settingsHref: themeSettingsHref, slot })
          }),
        )
        theme = { name: view.package.name, rows }
      }
    } catch (error) {
      payload.logger.error({ err: error as Error, msg: 'customer dashboard theme slots failed' })
    }
  }

  // Things that need the customer's attention, most urgent first. The site's own
  // lifecycle state comes before anything else: a suspended site is not serving, so
  // a domain or stock warning under it would be noise.
  const warnings: string[] = []
  if (site?.status === 'suspended') {
    warnings.push('سایت شما معلق شده است و در دسترس بازدیدکنندگان نیست؛ برای رفع تعلیق با پشتیبانی در تماس باشید.')
  } else if (site?.status === 'archived') {
    warnings.push('سایت شما بایگانی شده است و منتشر نمی‌شود.')
  }
  if (site?.domain && !site.domainVerified) {
    warnings.push('دامنهٔ شما هنوز تأیید نشده است؛ تا تأیید DNS، گواهی TLS صادر نمی‌شود.')
  }
  const unboundRequired = theme?.rows.filter((row) => row.required && row.state !== 'bound') ?? []
  if (unboundRequired.length > 0) {
    warnings.push(
      `پوسته به این موارد نیاز دارد و هنوز انتخاب نشده‌اند: ${unboundRequired.map((row) => row.label).join('، ')}.`,
    )
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
  const siteUrl = site?.domain ? deployOrigin(String(site.domain)) : null
  const statusLabel = site?.domainVerified
    ? 'دامنه تأییدشده'
    : site?.domain
      ? 'در انتظار تأیید دامنه'
      : 'دامنه‌ای ثبت نشده'

  // Site lifecycle — distinct from domain verification: «فعال» is serving, the
  // others are not. Straight from `sites.status`, never inferred.
  const lifecycleLabel =
    site?.status === 'suspended' ? 'معلق' : site?.status === 'archived' ? 'بایگانی‌شده' : 'فعال'
  // The site's own locales, by their platform label («فارسی», «English»), the
  // default marked. Falls back to the code for a locale not in the platform list.
  const localeNames = (site?.availableLocales ?? []).map((code) => {
    const label = locales.find((locale) => locale.code === code)?.label ?? code
    return code === site?.defaultLocale ? `${label} (پیش‌فرض)` : label
  })

  const shop = isShopSite(site?.type)
  const quickActions = quickActionsFor(site?.type)
  const statLinks = statLinksFor(site?.type)

  // The panel's sections for this site type, from the same map as the sidebar, so the two
  // can never disagree about what a shop has. `permissions` is the caller's own, so a
  // collection they may not read is not offered.
  const readable = (slug: string): boolean =>
    Boolean((permissions?.collections as Record<string, { read?: boolean }> | undefined)?.[slug]?.read)
  const panelGroups = CUSTOMER_NAV.map((group) => ({
    label: group.label,
    entities: group.entities.filter(
      (entity) =>
        entity.type === 'collection' &&
        readable(entity.slug) &&
        // Shop collections belong to a shop; hidden here exactly as in the sidebar.
        (shop || !(SHOP_COLLECTIONS as readonly string[]).includes(entity.slug)),
    ),
  })).filter((group) => group.entities.length > 0)
  const collectionLabel = (slug: string, fallback?: string): string => {
    const config = payload.config.collections.find((entry) => entry.slug === slug)
    const plural = config?.labels?.plural
    return fallback ?? (typeof plural === 'string' ? plural : slug)
  }

  return (
    <div className="eshobe-stack">
      <header className="eshobe-hero">
        <h2 className="eshobe-hero__title">{site?.name ? `مدیریت ${site.name}` : 'مدیریت سایت'}</h2>
        <div className="eshobe-hero__meta">
          <Chip tone={site?.status === 'active' || !site?.status ? 'ok' : 'warn'}>{lifecycleLabel}</Chip>
          <Chip>{shop ? 'فروشگاهی' : site?.type === 'portfolio' ? 'نمونه‌کار' : 'کسب‌وکار'}</Chip>
          {site?.domain ? (
            <Chip tone={site.domainVerified ? 'ok' : 'warn'}>
              <span className="eshobe-ltr">{String(site.domain)}</span>
              {` — ${statusLabel}`}
            </Chip>
          ) : (
            <Chip tone="warn">{statusLabel}</Chip>
          )}
          {localeNames.map((name) => (
            <Chip key={name}>{name}</Chip>
          ))}
        </div>
      </header>

      {warnings.length > 0 ? (
        <section className="eshobe-section">
          {warnings.map((warning) => (
            <div className="banner banner--type-warning" key={warning} style={{ margin: 0 }}>
              {warning}
            </div>
          ))}
        </section>
      ) : null}

      <Section title="دسترسی سریع">
        <div className="eshobe-actions">
          {quickActions.map((action) => (
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
          {themeSettingsHref && theme ? (
            <Action href={themeSettingsHref} label="تنظیمات پوسته" />
          ) : null}
          {siteUrl ? <Action external href={siteUrl} label="مشاهدهٔ سایت" primary /> : null}
        </div>
      </Section>

      <Section title="یک نگاه به سایت">
        <div className="eshobe-grid">
          {statLinks.map((stat: DashboardStat) => (
            <StatLink
              href={entityHref(adminRoute, stat.entity)}
              key={stat.entity.slug}
              label={stat.label}
              value={counts[stat.entity.slug] ?? 0}
            />
          ))}
        </div>
      </Section>

      {store ? (
        <Section title="فروشگاه">
          <div className="eshobe-grid">
            <StatLink
              href={ordersHref}
              label="سفارش‌های در انتظار پرداخت"
              value={store.orders.pending}
            />
            <StatLink href={ordersHref} label="سفارش‌های پرداخت‌شده" value={store.orders.paid} />
            <StatLink href={productsHref} label="محصولات منتشرشده" value={store.products.published} />
            <StatLink href={productsHref} label="رو به اتمام" value={store.products.lowStock} />
            <StatLink href={productsHref} label="ناموجود" value={store.products.outOfStock} />
          </div>
        </Section>
      ) : null}

      {theme && theme.rows.length > 0 ? (
        <Section title={`محتوای پوسته — ${theme.name}`}>
          <ul className="eshobe-list">
            {theme.rows.map((row) => (
              <li className="eshobe-list__row" key={row.key}>
                <div className="eshobe-list__main">
                  <span className="eshobe-list__label">{row.label}</span>
                  <span className="eshobe-list__hint">
                    {row.title ?? (row.required && row.state !== 'bound' ? 'الزامی' : '—')}
                  </span>
                </div>
                <Chip tone={row.state === 'bound' ? 'ok' : row.required ? 'warn' : undefined}>
                  {SLOT_STATE_LABEL[row.state]}
                </Chip>
                <div className="eshobe-list__links">
                  {row.extra ? <a href={row.extra.href}>{row.extra.label}</a> : null}
                  <a href={row.href}>{row.linkLabel}</a>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {panelGroups.map((group) => (
        <Section key={group.label} title={group.label}>
          <div className="eshobe-links">
            {group.entities.map((entity) => (
              <a className="eshobe-link" href={entityHref(adminRoute, entity)} key={entity.slug}>
                {collectionLabel(entity.slug, entity.label)}
              </a>
            ))}
          </div>
        </Section>
      ))}
    </div>
  )
}

export default CustomerDashboard
