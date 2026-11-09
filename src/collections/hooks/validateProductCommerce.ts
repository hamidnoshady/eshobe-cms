import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'
import { isMenuSourceId } from './validateMenuSource'

/**
 * Commerce shape rules for an expanded `products` row (issue #166).
 *
 * Variations are addressed by a stable per-product `key` — checkout sends
 * the key, order lines snapshot it, and a Woo re-import lands on it through
 * the variation's source id. That only works if keys are unique and always
 * present, so the hook derives one deterministically (`source-<id>`, then
 * SKU, then position) instead of letting an editor or importer leave a hole.
 * Relationship fields are checked against the product's own site for the
 * reason every hook in this folder repeats: access narrows what a caller may
 * see, it does not stop a caller naming another tenant's document by id.
 */
export const validateProductCommerce: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>
  const siteId = siteIdOfWrite(row, stored)
  const selfId = typeof stored.id === 'string' ? stored.id : null
  const errors: { message: string; path: string }[] = []

  const variations = Array.isArray(row.variations)
    ? (row.variations as Record<string, unknown>[])
    : null

  if (variations) {
    const keys = new Set<string>()
    const sourceIds = new Set<string>()

    variations.forEach((variation, index) => {
      const rawKey = typeof variation.key === 'string' ? variation.key.trim() : ''
      const sourceId =
        variation.sourceId === null || variation.sourceId === undefined
          ? ''
          : String(variation.sourceId).trim()
      const sku = typeof variation.sku === 'string' ? variation.sku.trim() : ''
      const key = rawKey || (sourceId ? `source-${sourceId}` : sku || `variation-${index + 1}`)
      variation.key = key

      if (keys.has(key.toLowerCase())) {
        errors.push({
          message: 'کلید هر تنوع باید در همین محصول یکتا باشد.',
          path: `variations.${index}.key`,
        })
      }
      keys.add(key.toLowerCase())

      if (sourceId) {
        if (sourceIds.has(sourceId)) {
          errors.push({
            message: 'شناسه مبدأ هر تنوع باید یکتا باشد.',
            path: `variations.${index}.sourceId`,
          })
        }
        sourceIds.add(sourceId)
      }

      if (variation.trackInventory === true) {
        const inventory = variation.inventory
        if (typeof inventory !== 'number' || !Number.isInteger(inventory) || inventory < 0) {
          errors.push({
            message: 'برای تنوعِ دارای ردیابی موجودی، موجودی عددیِ غیرمنفی لازم است.',
            path: `variations.${index}.inventory`,
          })
        }
      }
    })
  }

  const attributes = Array.isArray(row.attributes)
    ? (row.attributes as Record<string, unknown>[])
    : null

  if (attributes) {
    attributes.forEach((attribute, index) => {
      const options = Array.isArray(attribute.options)
        ? (attribute.options as Record<string, unknown>[])
        : []
      const seen = new Set<string>()

      for (const option of options) {
        const value = typeof option.value === 'string' ? option.value.trim().toLowerCase() : ''
        if (!value) continue
        if (seen.has(value)) {
          errors.push({
            message: 'گزینه‌های یک ویژگی نباید تکراری باشند.',
            path: `attributes.${index}.options`,
          })
          break
        }
        seen.add(value)
      }
    })
  }

  if (row.menuOrder !== undefined && row.menuOrder !== null && !Number.isSafeInteger(row.menuOrder)) {
    errors.push({ message: 'ترتیب منو باید عدد صحیح باشد.', path: 'menuOrder' })
  }

  if (Array.isArray(row.modifierGroups)) {
    const groupIds = new Set<string>()
    for (const [index, value] of row.modifierGroups.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ message: 'گروه افزودنی نامعتبر است.', path: `modifierGroups.${index}` })
        continue
      }
      const group = value as Record<string, unknown>
      const groupId = group?.sourceId
      if (!isMenuSourceId(groupId) || groupIds.has(groupId)) {
        errors.push({ message: 'شناسهٔ گروه افزودنی باید معتبر و در محصول یکتا باشد.', path: `modifierGroups.${index}.sourceId` })
      } else groupIds.add(groupId)
      const min = group.minSelections ?? 0
      const max = group.maxSelections ?? 1
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || Number(min) < 0 || Number(max) < 1 || Number(max) > 100 || Number(min) > Number(max)) {
        errors.push({ message: 'کمترین و بیشترین انتخاب باید عدد صحیح و سازگار باشند.', path: `modifierGroups.${index}.minSelections` })
      }
      if (group.menuOrder !== undefined && group.menuOrder !== null && !Number.isSafeInteger(group.menuOrder)) {
        errors.push({ message: 'ترتیب گروه باید عدد صحیح باشد.', path: `modifierGroups.${index}.menuOrder` })
      }
      const optionIds = new Set<string>()
      const options = Array.isArray(group.options) ? group.options : []
      for (const [optionIndex, value] of options.entries()) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          errors.push({ message: 'گزینهٔ افزودنی نامعتبر است.', path: `modifierGroups.${index}.options.${optionIndex}` })
          continue
        }
        const option = value as Record<string, unknown>
        const optionId = option.sourceId
        if (!isMenuSourceId(optionId) || optionIds.has(optionId)) {
          errors.push({ message: 'شناسهٔ گزینه باید معتبر و در گروه یکتا باشد.', path: `modifierGroups.${index}.options.${optionIndex}.sourceId` })
        } else optionIds.add(optionId)
        if (option.menuOrder !== undefined && option.menuOrder !== null && !Number.isSafeInteger(option.menuOrder)) {
          errors.push({ message: 'ترتیب گزینه باید عدد صحیح باشد.', path: `modifierGroups.${index}.options.${optionIndex}.menuOrder` })
        }
      }
    }
  }

  const productType =
    (typeof row.productType === 'string' && row.productType) ||
    (typeof stored.productType === 'string' && stored.productType) ||
    'simple'
  const status = row._status ?? stored._status
  const effectiveVariations = variations ??
    (Array.isArray(stored.variations) ? (stored.variations as unknown[]) : [])

  if (productType === 'variable' && status === 'published' && effectiveVariations.length === 0) {
    errors.push({
      message: 'محصول متغیرِ منتشرشده دست‌کم یک تنوع قابل خرید می‌خواهد.',
      path: 'variations',
    })
  }

  if (productType === 'external' && status === 'published') {
    const externalUrl = row.externalUrl ?? stored.externalUrl
    if (typeof externalUrl !== 'string' || !externalUrl.trim()) {
      errors.push({
        message: 'محصول خارجیِ منتشرشده نشانی مقصد می‌خواهد.',
        path: 'externalUrl',
      })
    }
  }

  if (errors.length) failField(collection, req, errors)
  if (!siteId) return data

  const checkOne = async (target: string, value: unknown, path: string): Promise<void> => {
    const targetId = idOf(value)
    if (!targetId) return
    const found = await findOnSite(req, target, targetId, siteId, { id: true })
    if (!found) {
      failField(collection, req, [
        { message: 'سند پیوندشده باید از همین سایت باشد.', path },
      ])
    }
  }
  const checkMany = async (target: string, value: unknown, path: string): Promise<void> => {
    if (!Array.isArray(value)) return
    for (const item of value) await checkOne(target, item, path)
  }

  // Media uploads (image, gallery and variation images) are deliberately not
  // re-checked here: the tenant-media-picker plugin validates every upload
  // relation against the destination site in `beforeChange`.
  const siteChanged = Boolean(originalDoc && siteId !== siteIdOfWrite(stored))
  const effectiveRelation = (key: string) =>
    Object.hasOwn(row, key) ? row[key] : siteChanged ? stored[key] : undefined
  await checkMany('taxonomy-terms', effectiveRelation('terms'), 'terms')
  await checkMany('products', effectiveRelation('upsells'), 'upsells')
  await checkMany('products', effectiveRelation('crossSells'), 'crossSells')

  const groupedProducts = effectiveRelation('groupedProducts')
  if (Array.isArray(groupedProducts)) {
    for (const value of groupedProducts) {
      const targetId = idOf(value)
      if (targetId && selfId && targetId === selfId) {
        failField(collection, req, [
          { message: 'محصول گروهی خودش را شامل نمی‌شود.', path: 'groupedProducts' },
        ])
      }
      await checkOne('products', value, 'groupedProducts')
    }
  }

  return data
}
