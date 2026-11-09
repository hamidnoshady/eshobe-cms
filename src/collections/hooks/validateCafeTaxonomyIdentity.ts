import type { CollectionBeforeValidateHook } from 'payload'

import { CAFE_MENU_TAXONOMY } from '@/lib/cafe-menu'
import { idOf } from '@/lib/ids'
import { failField } from './contentSameSite'

/**
 * Only the reserved café taxonomy participates in the compound unique index;
 * other taxonomy keys retain their existing behaviour. NULL is intentionally
 * distinct in PostgreSQL. Re-derive the marker on every write, never trust it
 * from an API body, and keep a populated café taxonomy on its original site.
 */
export const validateCafeTaxonomyIdentity: CollectionBeforeValidateHook = ({ collection, data, originalDoc, req }) => {
  if (!data) return data
  const row = data as Record<string, unknown>
  const previous = (originalDoc ?? {}) as Record<string, unknown>
  const key = row.key === undefined ? previous.key : row.key
  if (previous.key === CAFE_MENU_TAXONOMY && key !== CAFE_MENU_TAXONOMY) {
    failField(collection, req, [{ message: 'کلید طبقه‌بندی منوی کافه تغییرپذیر نیست.', path: 'key' }])
  }
  const nextSite = Object.hasOwn(row, 'site') ? idOf(row.site) : idOf(previous.site)
  if (previous.key === CAFE_MENU_TAXONOMY && nextSite !== idOf(previous.site)) {
    failField(collection, req, [{ message: 'سایت طبقه‌بندی منوی کافه تغییرپذیر نیست.', path: 'site' }])
  }
  row.cafeMenuIdentity = key === CAFE_MENU_TAXONOMY ? CAFE_MENU_TAXONOMY : null
  return data
}
