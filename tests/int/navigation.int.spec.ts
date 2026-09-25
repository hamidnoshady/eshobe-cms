// @vitest-environment node
//
// A pure unit test for the audience-aware sidebar resolver. It touches no
// database: `resolveNavGroups` is a synchronous function of the nav map, the
// user's role and the already-computed `visibleEntities` set. It is the panel
// half of the customer/platform split — the security half lives in
// `platform-saas.int.spec.ts` («access») and is asserted against `access`, not nav.
import { describe, expect, it } from 'vitest'

import {
  CUSTOMER_NAV,
  OTHER_GROUP_LABEL,
  PLATFORM_NAV,
  resolveNavGroups,
} from '@/admin/navigation'

const customer = { email: 'c@x', id: 'c', role: 'editor' }
const operator = { email: 'o@x', id: 'o', role: 'platformAdmin' }

/** The full set of slugs a given audience map references. */
const slugsOf = (nav: typeof CUSTOMER_NAV, type: 'collection' | 'global') =>
  nav.flatMap((g) => g.entities.filter((e) => e.type === type).map((e) => e.slug))

const everythingVisible = (nav: typeof CUSTOMER_NAV) => ({
  collections: slugsOf(nav, 'collection'),
  globals: slugsOf(nav, 'global'),
})

describe('resolveNavGroups', () => {
  it('gives a customer their website groups, never the control plane', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: customer,
      visible: everythingVisible(CUSTOMER_NAV),
    })
    const labels = groups.map((g) => g.label)
    expect(labels).toEqual(['وب‌سایت', 'محتوا', 'فروشگاه', 'طراحی', 'تیم', 'تنظیمات'])
    // No platform group leaks in, and nothing falls through to «سایر».
    expect(labels).not.toContain('مشتریان')
    expect(labels).not.toContain(OTHER_GROUP_LABEL)
  })

  it('gives an operator the platform console groups', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      visible: everythingVisible(PLATFORM_NAV),
    })
    const labels = groups.map((g) => g.label)
    expect(labels).toEqual([
      'مشتریان',
      'اشتراک و مالی',
      'محصول',
      'زیرساخت',
      'یکپارچه‌سازی',
      'عملیات',
      'تنظیمات سکو',
    ])
    expect(labels).not.toContain('وب‌سایت')
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

  it('sweeps a visible-but-unmapped entity into «سایر» so nothing is unreachable', () => {
    const groups = resolveNavGroups({
      adminRoute: '/admin',
      user: operator,
      // `sites` is mapped; `some-future-collection` is not.
      visible: { collections: ['sites', 'some-future-collection'], globals: [] },
    })
    const other = groups.find((g) => g.label === OTHER_GROUP_LABEL)
    expect(other?.entities.map((e) => e.slug)).toEqual(['some-future-collection'])
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
