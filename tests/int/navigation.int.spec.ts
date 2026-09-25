// @vitest-environment node
//
// Conformance test for the audience-aware sidebar. It touches no database:
// `resolveNavGroups` is a synchronous function of the nav map, the user's role
// and the already-computed `visibleEntities` set. This asserts the *product
// information architecture* — the exact group order, the child grouping and the
// Persian labels of both trees — not incidental presentation markup, which is
// what a nav conformance test should pin (task §28). The security half of the
// customer/platform split lives in `platform-saas.int.spec.ts` («access») and is
// asserted against `access`, not nav.
import { describe, expect, it } from 'vitest'

import {
  CUSTOMER_NAV,
  type NavGroupDef,
  OTHER_GROUP_LABEL,
  PLATFORM_NAV,
  resolveNavGroups,
} from '@/admin/navigation'

const customer = { email: 'c@x', id: 'c', role: 'editor' }
const operator = { email: 'o@x', id: 'o', role: 'platformAdmin' }

/** The full set of slugs a given audience map references. */
const slugsOf = (nav: NavGroupDef[], type: 'collection' | 'global') =>
  nav.flatMap((g) => g.entities.filter((e) => e.type === type).map((e) => e.slug))

const everythingVisible = (nav: NavGroupDef[]) => ({
  collections: slugsOf(nav, 'collection'),
  globals: slugsOf(nav, 'global'),
})

/** `label → [entity slugs in order]`, the shape the target IA is written in below. */
const treeOf = (groups: { entities: { slug: string }[]; label: string }[]) =>
  groups.map((g) => ({ entities: g.entities.map((e) => e.slug), label: g.label }))

/**
 * The exact customer information architecture (task §1). Every leaf is a real
 * tenant-scoped collection; concepts with no customer-visible collection of their
 * own (store «نمای کلی», the design/publishing catalogue, the settings sub-tabs)
 * are rendered inside an existing screen, not as a separate nav destination.
 */
const CUSTOMER_TARGET = [
  { entities: ['pages', 'header', 'footer', 'forms', 'form-submissions', 'search', 'redirects'], label: 'وب‌سایت' },
  { entities: ['posts', 'categories', 'media'], label: 'محتوا' },
  { entities: ['products', 'orders', 'payment-gateways', 'store'], label: 'فروشگاه' },
  { entities: ['theme'], label: 'طراحی و انتشار' },
  { entities: ['users'], label: 'تیم' },
  { entities: ['sites'], label: 'تنظیمات' },
]

/**
 * The exact platform information architecture (task §3). Supporting history/event
 * and per-site override tables are deliberately absent — they are demoted below.
 */
const PLATFORM_TARGET = [
  { entities: ['sites', 'users'], label: 'مشتریان' },
  { entities: ['plans', 'subscriptions', 'invoices'], label: 'اشتراک و مالی' },
  { entities: ['feature-flags', 'theme-templates', 'theme-packages', 'plugins'], label: 'محصول' },
  {
    entities: [
      'reseller-domains',
      'domain-reseller-products',
      'domain-reseller',
      'cdn-zones',
      'storage-connections',
      'deploy-targets',
      'payments',
    ],
    label: 'زیرساخت',
  },
  { entities: ['api-keys', 'webhooks'], label: 'یکپارچه‌سازی' },
  { entities: ['site-deployments', 'audit-log'], label: 'عملیات' },
  { entities: ['platform-settings'], label: 'تنظیمات سکو' },
]

/**
 * Collections with a legitimate backend purpose that must NOT be primary sidebar
 * products (task §3, §14, §15, §16, §17). They stay reachable through the «سایر»
 * catch-all — demoted, never deleted (task §23).
 */
const DEMOTED_SUPPORTING = [
  'usage-records',
  'site-entitlements',
  'site-theme-settings',
  'reseller-domain-operations',
  'reseller-domain-events',
  'cdn-events',
  'webhook-deliveries',
]

describe('sidebar information architecture', () => {
  it('renders the exact customer tree — groups, order, children and labels', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: customer,
      visible: everythingVisible(CUSTOMER_NAV),
    })

    expect(treeOf(groups)).toEqual(CUSTOMER_TARGET)
    // Nothing falls through to «سایر» when only the mapped entities are visible.
    expect(groups.map((g) => g.label)).not.toContain(OTHER_GROUP_LABEL)
  })

  it('gives the customer their product-oriented labels, not raw collection names', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: customer,
      visible: everythingVisible(CUSTOMER_NAV),
    })
    const label = (slug: string) => groups.flatMap((g) => g.entities).find((e) => e.slug === slug)?.label

    expect(label('theme')).toBe('طراحی سایت')
    expect(label('users')).toBe('اعضای تیم')
    expect(label('sites')).toBe('تنظیمات سایت')
    expect(label('payment-gateways')).toBe('پرداخت')
    expect(label('store')).toBe('تنظیمات فروشگاه')
  })

  it('never leaks a control-plane group into the customer tree', () => {
    const labels = resolveNavGroups({
      adminRoute: '/admin',
      user: customer,
      visible: everythingVisible(CUSTOMER_NAV),
    }).map((g) => g.label)

    for (const platform of ['مشتریان', 'اشتراک و مالی', 'زیرساخت', 'یکپارچه‌سازی', 'تنظیمات سکو']) {
      expect(labels).not.toContain(platform)
    }
  })

  it('renders the exact platform tree — groups, order, children and labels', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      visible: everythingVisible(PLATFORM_NAV),
    })

    expect(treeOf(groups)).toEqual(PLATFORM_TARGET)
    expect(groups.map((g) => g.label)).not.toContain('وب‌سایت')
  })

  it('gives the operator product-oriented infrastructure labels', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      visible: everythingVisible(PLATFORM_NAV),
    })
    const label = (slug: string) => groups.flatMap((g) => g.entities).find((e) => e.slug === slug)?.label

    expect(label('feature-flags')).toBe('قابلیت‌ها')
    expect(label('theme-templates')).toBe('پوسته‌ها')
    expect(label('plugins')).toBe('افزونه‌ها')
    expect(label('storage-connections')).toBe('ذخیره‌سازی')
    expect(label('deploy-targets')).toBe('سرورهای انتشار')
    expect(label('site-deployments')).toBe('انتشارها')
  })

  it('keeps supporting tables out of every primary platform group', () => {
    const primarySlugs = PLATFORM_NAV.flatMap((g) => g.entities.map((e) => e.slug))

    for (const slug of DEMOTED_SUPPORTING) {
      expect(primarySlugs, `${slug} must not be a primary platform nav item`).not.toContain(slug)
    }
  })

  it('demotes visible supporting tables into «سایر» rather than losing them', () => {
    // A real operator can see the supporting collections (they are `hiddenFromCustomers`,
    // i.e. visible to operators). They must still be reachable — the catch-all is
    // exactly that safety net (task §23: hide from primary nav, never delete).
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      visible: {
        collections: [...slugsOf(PLATFORM_NAV, 'collection'), ...DEMOTED_SUPPORTING],
        globals: slugsOf(PLATFORM_NAV, 'global'),
      },
    })
    const other = groups.find((g) => g.label === OTHER_GROUP_LABEL)

    expect(other, '«سایر» group should hold the demoted supporting tables').toBeTruthy()
    expect(new Set(other!.entities.map((e) => e.slug))).toEqual(new Set(DEMOTED_SUPPORTING))
    // And «سایر» is last, so demoted tables never sit above real products.
    expect(groups.at(-1)?.label).toBe(OTHER_GROUP_LABEL)
  })

  it('builds correct hrefs for collections vs globals and honours a non-default adminRoute', () => {
    const groups = resolveNavGroups({
      adminRoute: '/panel',
      user: operator,
      visible: { collections: ['sites'], globals: ['payments'] },
    })
    const entities = groups.flatMap((g) => g.entities)
    expect(entities.find((e) => e.slug === 'sites')?.href).toBe('/panel/collections/sites')
    expect(entities.find((e) => e.slug === 'payments')?.href).toBe('/panel/globals/payments')
  })

  it('drops entities the user cannot see', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: customer,
      visible: { collections: ['pages'], globals: [] },
    })
    const slugs = groups.flatMap((g) => g.entities.map((e) => e.slug))
    expect(slugs).toEqual(['pages'])
  })

  it('never lists the same entity twice', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      visible: everythingVisible(PLATFORM_NAV),
    })
    const keys = groups.flatMap((g) => g.entities.map((e) => `${e.type}:${e.slug}`))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
