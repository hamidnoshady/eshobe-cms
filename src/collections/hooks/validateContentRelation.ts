import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

/** Which single-target field carries each `targetCollection` value. */
export const CONTENT_RELATION_TARGET_FIELDS = {
  'content-entries': 'targetEntry',
  media: 'targetMedia',
  pages: 'targetPage',
  posts: 'targetPost',
  products: 'targetProduct',
} as const

/**
 * A typed edge from an entry to exactly one document, on the same site
 * (issue #166 §2, `content-relations`).
 *
 * The edge is stored as five single-relationship columns rather than one
 * polymorphic relationship: the target collection is itself data the theme
 * API filters on, and "exactly the named one is set" is then a check this
 * hook enforces on every write (a changed `targetCollection` clears the
 * previous target, which the admin's conditional fields also hide).
 */
export const validateContentRelation: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const merged: Record<string, unknown> = { ...(originalDoc ?? {}), ...data }
  const siteId = siteIdOfWrite(data, originalDoc)
  const fromEntryId = idOf(merged.fromEntry)
  const targetCollection = merged.targetCollection as string | undefined

  if (!siteId || !fromEntryId || !targetCollection) return data

  const fromEntry = await findOnSite(req, 'content-entries', fromEntryId, siteId, {
    title: true,
  })
  if (!fromEntry) {
    failField(collection, req, [
      { message: 'رکورد مبدأ رابطه متعلق به این سایت نیست.', path: 'fromEntry' },
    ])
  }

  const targetField =
    CONTENT_RELATION_TARGET_FIELDS[targetCollection as keyof typeof CONTENT_RELATION_TARGET_FIELDS]

  if (!targetField) {
    failField(collection, req, [
      { message: 'مجموعه مقصد رابطه پشتیبانی نمی‌شود.', path: 'targetCollection' },
    ])
  }

  const targetId = idOf(merged[targetField!])

  if (!targetId) {
    failField(collection, req, [{ message: 'سند مقصد رابطه را انتخاب کنید.', path: targetField! }])
  }

  const target = await findOnSite(req, targetCollection, targetId, siteId, { id: true } as never)
  if (!target) {
    failField(collection, req, [
      { message: 'سند مقصد رابطه متعلق به این سایت نیست.', path: targetField! },
    ])
  }

  const next: Record<string, unknown> = { ...data, [targetField!]: targetId }

  for (const field of Object.values(CONTENT_RELATION_TARGET_FIELDS)) {
    if (field !== targetField) next[field] = null
  }

  return next as typeof data
}
