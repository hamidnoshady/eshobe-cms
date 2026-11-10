import type React from 'react'

import type { MenuModifierGroup } from '@/lib/cafe-menu'

export type CafeMenuCategory = { id: string; name: string; description?: string | null; menuOrder?: number | null; sourceId?: string | null }
export type CafeMenuVariation = {
  key: string
  label: string
  price: number
  trackInventory?: boolean | null
  inventory?: number | null
}
export type CafeMenuItem = {
  id: string
  sourceId?: string | null
  title: string
  summary?: string | null
  image: React.ReactNode
  price: number
  menuOrder?: number | null
  menuAvailability?: string | null
  trackInventory?: boolean | null
  inventory?: number | null
  productType?: string | null
  variations: CafeMenuVariation[]
  categoryIds: string[]
  modifierGroups: MenuModifierGroup[]
}
