import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, parentChainOf, siteIdOfWrite } from './contentSameSite'

export const COMMENT_TARGET_FIELDS = {
  'content-entries': 'targetEntry',
  pages: 'targetPage',
  posts: 'targetPost',
  products: 'targetProduct',
} as const

export type CommentTargetCollection = keyof typeof COMMENT_TARGET_FIELDS

type Loose = Record<string, unknown>

const safeAuthorUrl = (value: unknown): boolean => {
  if (value === null || value === undefined || value === '') return true
  if (typeof value !== 'string') return false

  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Comment integrity (issue #166): a comment has exactly one target document,
 * every relationship stays inside the comment's own site, and a reply's
 * parent is a comment on that same target — never a convenient thread from
 * another post or another tenant. The four target columns mirror
 * `content-relations`: the collection is data a theme filters on, and this
 * hook is what keeps "exactly the named one is set" true on every write.
 */
export const validateComment: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const merged: Loose = { ...(originalDoc ?? {}), ...data }
  const siteId = siteIdOfWrite(data, originalDoc)
  const targetCollection = merged.targetCollection as CommentTargetCollection | undefined

  if (!siteId || !targetCollection) return data

  const targetField = COMMENT_TARGET_FIELDS[targetCollection]

  if (!targetField) {
    failField(collection, req, [
      { message: 'مجموعهٔ مقصد دیدگاه پشتیبانی نمی‌شود.', path: 'targetCollection' },
    ])
  }

  const targetId = idOf(merged[targetField!])

  if (!targetId) {
    failField(collection, req, [
      { message: 'سند مقصد دیدگاه را انتخاب کنید.', path: targetField! },
    ])
  }

  const target = await findOnSite(req, targetCollection, targetId, siteId, {
    id: true,
  } as never)
  if (!target) {
    failField(collection, req, [
      { message: 'سند مقصد دیدگاه متعلق به این سایت نیست.', path: targetField! },
    ])
  }

  const next: Loose = { ...data, [targetField!]: targetId }

  for (const field of Object.values(COMMENT_TARGET_FIELDS)) {
    if (field !== targetField) next[field] = null
  }

  const parentId = idOf(merged.parent)

  if (parentId) {
    const parent = await findOnSite(req, 'comments', parentId, siteId, {
      targetCollection: true,
      targetEntry: true,
      targetPage: true,
      targetPost: true,
      targetProduct: true,
    })
    if (!parent) {
      failField(collection, req, [
        { message: 'دیدگاه والد متعلق به این سایت نیست.', path: 'parent' },
      ])
    }

    const parentTargetField =
      COMMENT_TARGET_FIELDS[parent!.targetCollection as CommentTargetCollection]
    if (
      parent!.targetCollection !== targetCollection ||
      !parentTargetField ||
      idOf(parent![parentTargetField]) !== targetId
    ) {
      failField(collection, req, [
        { message: 'دیدگاه والد باید روی همان سند مقصد باشد.', path: 'parent' },
      ])
    }

    const ownId = originalDoc?.id ? String(originalDoc.id) : null
    if (
      ownId &&
      (parentId === ownId || (await parentChainOf(req, 'comments', parentId, siteId)).includes(ownId))
    ) {
      failField(collection, req, [
        { message: 'این والد، دور در رشتهٔ دیدگاه‌ها می‌سازد.', path: 'parent' },
      ])
    }
  }

  const customerId = idOf(merged.authorCustomer)
  if (customerId) {
    const customer = await findOnSite(req, 'customers', customerId, siteId, { id: true } as never)
    if (!customer) {
      failField(collection, req, [
        { message: 'مشتری نویسنده متعلق به این سایت نیست.', path: 'authorCustomer' },
      ])
    }
  }

  const userId = idOf(merged.authorUser)
  if (userId) {
    const user = await req.payload.findByID({
      collection: 'users',
      depth: 0,
      disableErrors: true,
      id: userId,
      overrideAccess: true,
      req,
      select: { role: true, tenants: true },
    }) as null | {
      role?: string
      tenants?: { tenant: unknown }[]
    }
    const belongs =
      user?.role === 'platformAdmin' ||
      (user?.tenants ?? []).some((row) => idOf(row.tenant) === siteId)

    if (!belongs) {
      failField(collection, req, [
        { message: 'کاربر نویسنده عضو این سایت نیست.', path: 'authorUser' },
      ])
    }
  }

  if (!safeAuthorUrl(merged.authorUrl)) {
    failField(collection, req, [
      { message: 'نشانی نویسنده باید http/https باشد.', path: 'authorUrl' },
    ])
  }

  const rating = merged.rating
  if (
    rating !== null &&
    rating !== undefined &&
    (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5)
  ) {
    failField(collection, req, [
      { message: 'امتیاز دیدگاه باید عددی میان ۰ تا ۵ باشد.', path: 'rating' },
    ])
  }

  if (!merged.submittedAt) next.submittedAt = new Date().toISOString()

  return next as typeof data
}
