import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, parentChainOf, siteIdOfWrite } from './contentSameSite'

/** A page's parent must be the same site's page, and never its own descendant. */
export const validatePageParent: CollectionBeforeValidateHook = async ({
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
    failField(collection, req, [{ message: 'برگه والد خودش نیست.', path: 'parent' }])
  }

  const parent = await findOnSite(req, 'pages', parentId, siteId, { title: true })
  if (!parent) {
    failField(collection, req, [
      { message: 'برگه والد باید از همین سایت باشد.', path: 'parent' },
    ])
  }

  if (selfId) {
    const ancestors = await parentChainOf(req, 'pages', parentId, siteId)
    if (ancestors.includes(selfId)) {
      failField(collection, req, [
        { message: 'برگه والد نمی‌تواند از فرزندان همین برگه باشد.', path: 'parent' },
      ])
    }
  }

  return data
}
