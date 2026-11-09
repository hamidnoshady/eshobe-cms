/** Shared, deterministic menu rules. Browser calculations are previews only; checkout
 * runs these again against freshly read, published, same-site product records. */

export const CAFE_MENU_TAXONOMY = 'cafe_menu_category'

export type MenuOption = {
  sourceId: string
  label: string
  priceDelta: number
  active?: boolean | null
  menuOrder?: number | null
}
export type MenuModifierGroup = {
  sourceId: string
  label: string
  minSelections: number
  maxSelections: number
  active?: boolean | null
  menuOrder?: number | null
  options?: MenuOption[] | null
}
export type ModifierChoice = { groupId: string; optionIds: string[] }
export type ModifierSnapshot = {
  groupSourceId: string
  groupLabel: string
  optionSourceId: string
  optionLabel: string
  priceDelta: number
  quantity: number
}

/** Keep accounting order stable even when several records share an order number. */
export const menuSort = <T extends { menuOrder?: number | null; sourceId?: string | null; id?: string | null }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => {
    const byOrder = (a.menuOrder ?? 0) - (b.menuOrder ?? 0)
    if (byOrder) return byOrder
    const left = a.sourceId ?? a.id ?? ''
    const right = b.sourceId ?? b.id ?? ''
    return left < right ? -1 : left > right ? 1 : 0
  })

export const menuAvailability = (product: {
  menuAvailability?: string | null
  inventory?: number | null
  trackInventory?: boolean | null
}): 'available' | 'sold_out' | 'unavailable' => {
  if (product.menuAvailability === 'sold_out') return 'sold_out'
  if (product.menuAvailability && product.menuAvailability !== 'available') return 'unavailable'
  // A tracked-but-missing projection is not evidence of unlimited stock.
  if (product.trackInventory) {
    if (!Number.isSafeInteger(product.inventory) || Number(product.inventory) < 0) return 'unavailable'
    if (product.inventory === 0) return 'sold_out'
  }
  return 'available'
}

type ModifierResult =
  | { ok: true; priceDelta: number; snapshots: ModifierSnapshot[] }
  | { ok: false }

/**
 * Reject unknown/inactive/duplicate selections and enforce each active group's bounds.
 * Options are chosen at most once per item; the line quantity multiplies their delta.
 * A stale or corrupt modifier definition fails closed, rather than guessing a price.
 */
export const resolveModifiers = (
  groups: readonly MenuModifierGroup[] | null | undefined,
  input: unknown,
): ModifierResult => {
  if (input !== undefined && !Array.isArray(input)) return { ok: false }
  const choices = (input ?? []) as unknown[]
  const definitions = groups ?? []
  if (choices.length > 50 || definitions.length > 50) return { ok: false }

  const selected = new Map<string, string[]>()
  for (const raw of choices) {
    if (!raw || typeof raw !== 'object') return { ok: false }
    const choice = raw as Record<string, unknown>
    if (typeof choice.groupId !== 'string' || !Array.isArray(choice.optionIds) || choice.optionIds.length > 100 || selected.has(choice.groupId)) {
      return { ok: false }
    }
    if (!choice.optionIds.every((id) => typeof id === 'string') || new Set(choice.optionIds).size !== choice.optionIds.length) {
      return { ok: false }
    }
    selected.set(choice.groupId, choice.optionIds as string[])
  }

  const seenGroups = new Set<string>()
  const snapshots: ModifierSnapshot[] = []
  let priceDelta = 0
  for (const group of menuSort(definitions)) {
    if (!group.sourceId || seenGroups.has(group.sourceId)) return { ok: false }
    seenGroups.add(group.sourceId)
    const optionIds = selected.get(group.sourceId) ?? []
    selected.delete(group.sourceId)
    if (group.active === false) {
      if (optionIds.length) return { ok: false }
      continue
    }
    const min = group.minSelections ?? 0
    const max = group.maxSelections ?? 1
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || max < 1 || max > 100 || min > max || optionIds.length < min || optionIds.length > max) {
      return { ok: false }
    }
    const options = menuSort(group.options ?? [])
    if (options.length > 100 || new Set(options.map((option) => option.sourceId)).size !== options.length) return { ok: false }
    for (const optionId of optionIds) {
      const option = options.find((candidate) => candidate.sourceId === optionId && candidate.active !== false)
      if (!option || !Number.isSafeInteger(option.priceDelta) || !group.label || !option.label) return { ok: false }
      priceDelta += option.priceDelta
      if (!Number.isSafeInteger(priceDelta)) return { ok: false }
      snapshots.push({
        groupSourceId: group.sourceId,
        groupLabel: group.label,
        optionSourceId: option.sourceId,
        optionLabel: option.label,
        priceDelta: option.priceDelta,
        quantity: 1,
      })
    }
  }
  if (selected.size) return { ok: false }
  return { ok: true, priceDelta, snapshots }
}
