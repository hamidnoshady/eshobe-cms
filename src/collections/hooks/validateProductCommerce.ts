import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

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
  await checkMany('taxonomy-terms', row.terms, 'terms')
  await checkMany('products', row.upsells, 'upsells')
  await checkMany('products', row.crossSells, 'crossSells')

  if (Array.isArray(row.groupedProducts)) {
    for (const value of row.groupedProducts) {
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
