// @vitest-environment node
//
// The panel half of the customer/platform split, asserted against the *built*
// Payload config rather than a browser or a database. `admin.hidden` is a
// synchronous function of the user, and the sidebar's information architecture is
// a static map (`src/admin/navigation.ts`), so every collection and global can be
// covered here — no Postgres, no Playwright — and the check runs in CI on every
// push.
//
// This is deliberately *not* the security boundary: that is each entity's `access`
// function, exercised against real requests in `platform-saas.int.spec.ts`
// («access») and `tenancy.int.spec.ts`. A collection in the wrong list here is a
// usability bug; a collection missing `platformAdmin` access is an incident. The
// two are tested apart on purpose.
import { describe, expect, it } from 'vitest'

import configPromise from '@/payload.config'
import { CUSTOMER_NAV, OTHER_GROUP_LABEL, PLATFORM_NAV, resolveNavGroups } from '@/admin/navigation'

type Entity = { admin?: { group?: unknown; hidden?: unknown }; slug: string }

const editor = { email: 'editor@site.test', id: 'editor', role: 'editor' }
const operator = { email: 'op@eshobe.test', id: 'op', role: 'platformAdmin' }

// Mirrors `@payloadcms/ui`'s getVisibleEntities: nav visibility is `!admin.hidden`.
const isHidden = (hidden: unknown, user: unknown): boolean => {
  if (typeof hidden === 'function') {
    try {
      return (hidden as (a: { user: unknown }) => boolean)({ user })
    } catch {
      return true
    }
  }
  return Boolean(hidden)
}

// Payload's own bookkeeping collections/globals never belong in a product sidebar.
const isInternal = (slug: string): boolean => slug.startsWith('payload-')

const loadConfig = async () => {
  const config = await configPromise
  const collections = (config.collections as unknown as Entity[]).filter((c) => !isInternal(c.slug))
  const globals = (config.globals as unknown as Entity[]).filter((g) => !isInternal(g.slug))
  return { collections, globals }
}

const visibleFor = (
  { collections, globals }: { collections: Entity[]; globals: Entity[] },
  user: unknown,
) => ({
  collections: collections.filter((c) => !isHidden(c.admin?.hidden, user)).map((c) => c.slug),
  globals: globals.filter((g) => !isHidden(g.admin?.hidden, user)).map((g) => g.slug),
})

const navKeys = (nav: typeof CUSTOMER_NAV) =>
  new Set(nav.flatMap((g) => g.entities.map((e) => `${e.type}:${e.slug}`)))

// Which nav group (if any) an entity sits in, for the contextual-grouping checks.
const groupOf = (nav: typeof CUSTOMER_NAV, type: 'collection' | 'global', slug: string) =>
  nav.find((g) => g.entities.some((e) => e.type === type && e.slug === slug))?.label

describe('admin nav visibility (config-level)', () => {
  it('shows a customer their website collections and none of the control plane', async () => {
    const cfg = await loadConfig()
    const visible = visibleFor(cfg, editor)

    for (const slug of ['pages', 'posts', 'media', 'categories', 'products', 'orders', 'store', 'theme', 'header', 'footer', 'forms', 'form-submissions', 'redirects', 'search', 'payment-gateways']) {
      expect(visible.collections, slug).toContain(slug)
    }
    for (const slug of ['plans', 'subscriptions', 'invoices', 'usage-records', 'site-entitlements', 'feature-flags', 'plugins', 'theme-templates', 'theme-packages', 'deploy-targets', 'site-deployments', 'webhooks', 'webhook-deliveries', 'audit-log', 'api-keys', 'storage-connections', 'cdn-zones', 'cdn-events']) {
      expect(visible.collections, slug).not.toContain(slug)
    }
  })

  it('shows an operator the control plane and none of the site content', async () => {
    const cfg = await loadConfig()
    const visible = visibleFor(cfg, operator)

    for (const slug of ['webhooks', 'audit-log', 'api-keys', 'storage-connections', 'site-deployments', 'billing-usage-outbox', 'central-entitlement-projections']) {
      expect(visible.collections, slug).toContain(slug)
    }
    for (const slug of ['pages', 'posts', 'media', 'products', 'orders', 'store', 'theme', 'redirects']) {
      expect(visible.collections, slug).not.toContain(slug)
    }
  })

  it('hides the three platform globals from a customer and shows them to an operator', async () => {
    const cfg = await loadConfig()
    // Regression for the leak fixed alongside the nav refactor: these carry
    // `access.read: platformAdmin` but had no `admin.hidden`, so they showed to a
    // customer as links that answered 403. `getVisibleEntities` reads only `hidden`.
    for (const slug of ['payments', 'domain-reseller', 'platform-settings']) {
      expect(visibleFor(cfg, editor).globals, slug).not.toContain(slug)
      expect(visibleFor(cfg, operator).globals, slug).toContain(slug)
    }
  })

  it('places every customer-visible entity in the customer sidebar — no orphans', async () => {
    const cfg = await loadConfig()
    const visible = visibleFor(cfg, editor)
    const map = navKeys(CUSTOMER_NAV)
    const orphans = [
      ...visible.collections.map((s) => `collection:${s}`),
      ...visible.globals.map((s) => `global:${s}`),
    ].filter((k) => !map.has(k))
    expect(orphans, 'a visible entity is missing from CUSTOMER_NAV').toEqual([])
  })

  it('leaves no operator-visible entity unreachable — everything resolves into some group', async () => {
    // The static PLATFORM_NAV map intentionally omits the demoted supporting tables
    // (they are not primary products), so "orphan against the map" is now expected
    // for those. The invariant that still must hold is *reachability*: after
    // `resolveNavGroups` sweeps unmapped-but-visible entities into «سایر», every
    // operator-visible entity appears in exactly one resolved group.
    const cfg = await loadConfig()
    const visible = visibleFor(cfg, operator)
    const groups = resolveNavGroups({ adminRoute: '/admin', user: operator, visible })
    const reachable = new Set(groups.flatMap((g) => g.entities.map((e) => `${e.type}:${e.slug}`)))
    const unreachable = [
      ...visible.collections.map((s) => `collection:${s}`),
      ...visible.globals.map((s) => `global:${s}`),
    ].filter((k) => !reachable.has(k))
    expect(unreachable, 'an operator-visible entity resolves into no nav group at all').toEqual([])
  })

  it('groups a customer submissions table with its parent form, not as its own section', async () => {
    // The product-oriented rule for the customer tree: form-submissions is reached
    // through the same «وب‌سایت» area as forms, never as an unrelated sibling.
    expect(groupOf(CUSTOMER_NAV, 'collection', 'form-submissions')).toBe(
      groupOf(CUSTOMER_NAV, 'collection', 'forms'),
    )
  })

  it('demotes platform supporting/history tables out of every primary group', async () => {
    // The platform equivalent: per-site override and history/event tables are not
    // primary products. They must not appear in any PLATFORM_NAV group (they land in
    // «سایر» at resolve time instead — proven in navigation.int.spec.ts).
    const primary = new Set(PLATFORM_NAV.flatMap((g) => g.entities.map((e) => e.slug)))
    for (const slug of [
      'usage-records',
      'site-entitlements',
      'site-theme-settings',
      'cdn-events',
      'webhook-deliveries',
      'reseller-domain-operations',
      'reseller-domain-events',
    ]) {
      expect(primary, `${slug} must not be a primary platform product`).not.toContain(slug)
    }
  })
})

describe('admin nav resolution against the real config', () => {
  it('renders the customer information architecture end-to-end', async () => {
    const cfg = await loadConfig()
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: editor,
      visible: visibleFor(cfg, editor),
    })
    const labels = groups.map((g) => g.label)
    expect(labels).toEqual(['وب‌سایت', 'محتوا', 'فروشگاه', 'طراحی و انتشار', 'تیم', 'تنظیمات'])
    // A customer sees every website group and nothing falls through to «سایر».
    expect(labels).not.toContain(OTHER_GROUP_LABEL)
    // A control-plane link never appears in a customer's resolved nav.
    const allSlugs = groups.flatMap((g) => g.entities.map((e) => e.slug))
    expect(allSlugs).not.toContain('plans')
    expect(allSlugs).not.toContain('audit-log')
  })

  it('renders the platform information architecture end-to-end', async () => {
    const cfg = await loadConfig()
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      visible: visibleFor(cfg, operator),
    })
    const labels = groups.map((g) => g.label)
    // The seven primary product groups, in order — then «سایر» last, because a real
    // operator can see the demoted supporting tables and they sweep into the catch-all.
    expect(labels).toEqual([
      'مشتریان',
      'محصول',
      'زیرساخت',
      'یکپارچه‌سازی',
      'عملیات',
      'تنظیمات سکو',
      OTHER_GROUP_LABEL,
    ])
    // No site-content leaks into the operator's console.
    const allSlugs = groups.flatMap((g) => g.entities.map((e) => e.slug))
    expect(allSlugs).not.toContain('pages')
    expect(allSlugs).not.toContain('posts')
    // The demoted tables are exactly what «سایر» holds — reachable, never primary.
    const other = groups.find((g) => g.label === OTHER_GROUP_LABEL)
    expect(other?.entities.map((e) => e.slug).sort()).toEqual(
      [
        'billing-storage-accounts',
        'billing-usage-samples',
        'cdn-events',
        'reseller-domain-events',
        'reseller-domain-operations',
        'site-entitlements',
        'site-theme-settings',
        'usage-records',
        'webhook-deliveries',
      ].sort(),
    )
  })

  it('every control-plane collection carries a non-empty admin.group for its breadcrumb', async () => {
    const cfg = await loadConfig()
    const controlPlane = ['plans', 'subscriptions', 'invoices', 'webhooks', 'audit-log', 'api-keys', 'storage-connections', 'cdn-zones']
    for (const slug of controlPlane) {
      const entry = cfg.collections.find((c) => c.slug === slug)
      const group = entry?.admin?.group
      expect(typeof group === 'string' ? group : '', slug).not.toBe('')
    }
  })
})
