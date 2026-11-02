import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, parentChainOf, siteIdOfWrite } from './contentSameSite'

/** A blog category's parent must be the same site's category, and never its own descendant. */
export const validateCategoryParent: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  const row = (data ?? {}) as Record<string, unknown>
  const stored = (originalDoc ?? {}) as Record<string, unknown>
  const parentId = idOf(row.parent)
  const siteId = siteIdOfWrite(row, stored)

  if (!parentId || !siteId) return data

  const selfId = typeof stored.id === 'string' ? stored.id : null
  if (selfId && parentId === selfId) {
    failField(collection, req, [{ message: 'دسته والد خودش نیست.', path: 'parent' }])
  }

  const parent = await findOnSite(req, 'categories', parentId, siteId, { id: true })
  if (!parent) {
    failField(collection, req, [
      { message: 'دسته والد باید از همین سایت باشد.', path: 'parent' },
    ])
  }

  if (selfId) {
    const ancestors = await parentChainOf(req, 'categories', parentId, siteId)
    if (ancestors.includes(selfId)) {
      failField(collection, req, [
        { message: 'دسته والد نمی‌تواند از فرزندان همین دسته باشد.', path: 'parent' },
      ])
    }
  }

  return data
}
