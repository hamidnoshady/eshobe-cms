// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { buildSlotRow } from '@/lib/themeSlotLinks'

const base = { adminRoute: '/admin', settingsHref: '/admin/collections/sites/s1/theme-settings' }
const slot = (type: 'category' | 'media' | 'page', required = false) => ({
  key: `${type}Slot`,
  labelFa: 'برچسب',
  required,
  type,
})

describe('buildSlotRow', () => {
  it('sends an unbound slot to the theme settings screen', () => {
    const row = buildSlotRow({ ...base, binding: null, doc: null, slot: slot('page', true) })
    expect(row).toMatchObject({ href: base.settingsHref, required: true, state: 'unbound' })
  })

  it('reports a binding whose document is gone as missing, not bound', () => {
    const row = buildSlotRow({ ...base, binding: { id: 'x', type: 'page' }, doc: null, slot: slot('page') })
    expect(row.state).toBe('missing')
    expect(row.href).toBe(base.settingsHref)
  })

  it('links a bound page to its edit screen with its title', () => {
    const row = buildSlotRow({ ...base, binding: { id: 'p1' }, doc: { title: 'خانه' }, slot: slot('page') })
    expect(row).toMatchObject({ href: '/admin/collections/pages/p1', state: 'bound', title: 'خانه' })
  })

  it('offers the posts filed under a bound category', () => {
    const row = buildSlotRow({ ...base, binding: { id: 'c1' }, doc: { title: 'وبلاگ' }, slot: slot('category') })
    expect(row.href).toBe('/admin/collections/categories/c1')
    expect(row.extra?.href).toBe('/admin/collections/posts?where[categories][in][0]=c1')
  })

  it('titles a media binding by its filename', () => {
    const row = buildSlotRow({ ...base, binding: { id: 'm1' }, doc: { filename: 'logo.svg' }, slot: slot('media') })
    expect(row.title).toBe('logo.svg')
  })

  it('honours a root-mounted admin', () => {
    const row = buildSlotRow({ ...base, adminRoute: '/', binding: { id: 'p1' }, doc: { title: 't' }, slot: slot('page') })
    expect(row.href).toBe('/collections/pages/p1')
  })
})
