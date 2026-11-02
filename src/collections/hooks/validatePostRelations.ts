import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

/**
 * A post may only reference its own site's hero image, categories, generic
 * taxonomy terms and related posts. The generic terms are how imported
 * WordPress tags stay attached to a native post without pretending they are
 * blog categories.
 */
export const validatePostRelations: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const siteId = siteIdOfWrite(row, (originalDoc ?? {}) as Record<string, unknown>)

  if (!siteId) return data

  const one = async (target: string, value: unknown, path: string): Promise<void> => {
    const targetId = idOf(value)
    if (!targetId) return
    const found = await findOnSite(req, target, targetId, siteId, { id: true })
    if (!found) {
      failField(collection, req, [{ message: 'سند پیوندشده باید از همین سایت باشد.', path }])
    }
  }
  const many = async (target: string, value: unknown, path: string): Promise<void> => {
    if (!Array.isArray(value)) return
    for (const item of value) await one(target, item, path)
  }

  await one('media', row.heroImage, 'heroImage')
  await many('posts', row.relatedPosts, 'relatedPosts')
  await many('categories', row.categories, 'categories')
  await many('taxonomy-terms', row.taxonomyTerms, 'taxonomyTerms')

  return data
}
