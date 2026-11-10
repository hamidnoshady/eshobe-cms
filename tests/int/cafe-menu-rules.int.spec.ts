import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { menuAvailability, menuSort, resolveModifiers } from '@/lib/cafe-menu'
import { withDerivedSiteWrite } from '@/lib/derived-site-write'

const groups = [
  {
    sourceId: 'milk', label: 'Milk', minSelections: 1, maxSelections: 1, active: true, menuOrder: 2,
    options: [
      { sourceId: 'oat', label: 'Oat', priceDelta: 25, active: true, menuOrder: 1 },
      { sourceId: 'dairy', label: 'Dairy', priceDelta: -5, active: true, menuOrder: 0 },
      { sourceId: 'inactive', label: 'Unavailable', priceDelta: 2, active: false },
    ],
  },
  {
    sourceId: 'extras', label: 'Extras', minSelections: 0, maxSelections: 2, active: true, menuOrder: 1,
    options: [
      { sourceId: 'shot', label: 'Shot', priceDelta: 10 },
      { sourceId: 'syrup', label: 'Syrup', priceDelta: 15 },
      { sourceId: 'ice', label: 'Ice', priceDelta: 0 },
    ],
  },
  { sourceId: 'disabled', label: 'Disabled', minSelections: 1, maxSelections: 1, active: false, options: [{ sourceId: 'x', label: 'X', priceDelta: 1 }] },
]

describe('café menu rules', () => {
  it('restores REST mode and the ambient session after a derived-site write, even on failure', async () => {
    const user = { id: 'ambient-user' }
    const req = { payloadAPI: 'REST', user } as unknown as PayloadRequest
    await expect(withDerivedSiteWrite(req, async () => {
      expect(req.payloadAPI).toBe('local')
      expect(req.user).toBeNull()
      throw new Error('validation failed')
    })).rejects.toThrow('validation failed')
    expect(req.payloadAPI).toBe('REST')
    expect(req.user).toBe(user)
  })

  it('orders by accounting order, with a stable source-id tie breaker', () => {
    expect(menuSort([{ sourceId: 'b', menuOrder: 1 }, { sourceId: 'c', menuOrder: 0 }, { sourceId: 'a', menuOrder: 1 }]).map((x) => x.sourceId)).toEqual(['c', 'a', 'b'])
  })

  it('keeps sellability independent of publication and does not invent tracked stock', () => {
    expect(menuAvailability({ menuAvailability: 'sold_out', trackInventory: false })).toBe('sold_out')
    expect(menuAvailability({ menuAvailability: 'unavailable', inventory: 10, trackInventory: true })).toBe('unavailable')
    expect(menuAvailability({ menuAvailability: 'available', trackInventory: true, inventory: null })).toBe('unavailable')
    expect(menuAvailability({ menuAvailability: 'available', trackInventory: false, inventory: null })).toBe('available')
    expect(menuAvailability({ menuAvailability: 'available', trackInventory: true, inventory: 0 })).toBe('sold_out')
  })

  it('requires mandatory groups, enforces min/max, and rejects stale or forged selections', () => {
    const invalid: unknown[] = [
      [],
      [{ groupId: 'milk', optionIds: ['oat', 'dairy'] }],
      [{ groupId: 'milk', optionIds: ['inactive'] }],
      [{ groupId: 'milk', optionIds: ['oat', 'oat'] }],
      [{ groupId: 'milk', optionIds: ['oat'] }, { groupId: 'milk', optionIds: ['dairy'] }],
      [{ groupId: 'milk', optionIds: ['oat'] }, { groupId: 'unknown', optionIds: [] }],
      [{ groupId: 'milk', optionIds: ['oat'] }, { groupId: 'disabled', optionIds: ['x'] }],
      [{ groupId: 'milk', optionIds: ['oat'] }, { groupId: 'extras', optionIds: ['shot', 'syrup', 'ice'] }],
      [{ groupId: 'milk', optionIds: 'oat' }],
    ]
    for (const selection of invalid) expect(resolveModifiers(groups, selection)).toEqual({ ok: false })
  })

  it('snapshots current labels and signed integer deltas, not submitted prices', () => {
    const selection = resolveModifiers(groups, [
      { groupId: 'milk', optionIds: ['dairy'], priceDelta: 9999 },
      { groupId: 'extras', optionIds: ['shot', 'syrup'] },
    ])
    expect(selection).toEqual({ ok: true, priceDelta: 20, snapshots: [
      { groupSourceId: 'extras', groupLabel: 'Extras', optionSourceId: 'shot', optionLabel: 'Shot', priceDelta: 10, quantity: 1 },
      { groupSourceId: 'extras', groupLabel: 'Extras', optionSourceId: 'syrup', optionLabel: 'Syrup', priceDelta: 15, quantity: 1 },
      { groupSourceId: 'milk', groupLabel: 'Milk', optionSourceId: 'dairy', optionLabel: 'Dairy', priceDelta: -5, quantity: 1 },
    ] })
    expect(resolveModifiers([{ ...groups[0]!, options: [{ sourceId: 'oat', label: 'Oat', priceDelta: 0.5 }] }], [{ groupId: 'milk', optionIds: ['oat'] }])).toEqual({ ok: false })
  })
})
