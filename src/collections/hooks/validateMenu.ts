import type { CollectionBeforeValidateHook } from 'payload'

import { idOf } from '@/lib/ids'

import { failField, findOnSite, siteIdOfWrite } from './contentSameSite'

export const MENU_TARGET_COLLECTIONS = [
  'pages',
  'posts',
  'products',
  'content-entries',
  'categories',
  'taxonomy-terms',
  'media',
] as const

type MenuTargetCollection = (typeof MENU_TARGET_COLLECTIONS)[number]
type Loose = Record<string, unknown>

const asRecord = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {}

const safeMenuUrl = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value.trim()) return false
  const url = value.trim()

  if (url.startsWith('/')) return !url.startsWith('//')

  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const referenceParts = (
  value: unknown,
): null | { relationTo: string; value: null | string } => {
  const record = asRecord(value)
  if (typeof record.relationTo !== 'string') return null

  return { relationTo: record.relationTo, value: idOf(record.value) }
}

/**
 * Menu integrity (issue #166): one menu belongs to one site, every item key
 * is unique inside that menu, parents are keys in the same flat item list,
 * and every referenced document is a document of that same site.
 *
 * Items are stored flat, in source/menu order, with `parentKey` rather than
 * nested repeaters. That keeps a WordPress menu tree lossless without
 * generating one database table per nesting level; `depth` is derived here
 * so renderers can either use the tree (`key`/`parentKey`) or a simple
 * indented list.
 */
export const validateMenu: CollectionBeforeValidateHook = async ({
  collection,
  data,
  originalDoc,
  req,
}) => {
  if (!data) return data

  const siteId = siteIdOfWrite(data, originalDoc)
  const next: Loose = { ...data }

  if (!siteId) return next as typeof data

  if (typeof data.slug === 'string' && data.slug.trim()) {
    const { docs } = await req.payload.find({
      collection: 'menus',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [{ site: { equals: siteId } }, { slug: { equals: data.slug.trim() } }],
      },
    })
    const clash = docs[0]

    if (clash && String(clash.id) !== String(originalDoc?.id ?? '')) {
      failField(collection, req, [
        { message: 'کلید این منو برای همین سایت پیش‌تر به کار رفته است.', path: 'slug' },
      ])
    }
    next.slug = data.slug.trim()
  }

  if (data.locations !== undefined && data.locations !== null) {
    const locations = data.locations
    if (
      !Array.isArray(locations) ||
      locations.length > 32 ||
      locations.some((value) => typeof value !== 'string' || !value.trim() || value.length > 100)
    ) {
      failField(collection, req, [
        { message: 'جایگاه‌های منو باید فهرستی کوتاه از نام‌های متنی باشند.', path: 'locations' },
      ])
    }
    const normalized = [...new Set((locations as string[]).map((value) => value.trim()))]
    next.locations = normalized
    if (!next.location && normalized[0]) next.location = normalized[0]
  }

  if (!('items' in data) || data.items === undefined) return next as typeof data
  if (!Array.isArray(data.items)) {
    failField(collection, req, [{ message: 'آیتم‌های منو باید فهرست باشند.', path: 'items' }])
  }
  if (data.items!.length > 1_000) {
    failField(collection, req, [
      { message: 'یک منو نمی‌تواند بیش از هزار آیتم داشته باشد.', path: 'items' },
    ])
  }

  const items = (data.items as Loose[]).map((item) => ({ ...item }))
  const byKey = new Map<string, Loose>()

  items.forEach((item, index) => {
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    if (!key) {
      failField(collection, req, [
        { message: 'هر آیتم منو یک کلید یکتا می‌خواهد.', path: `items.${index}.key` },
      ])
    }
    if (byKey.has(key)) {
      failField(collection, req, [
        { message: `کلید آیتم منو «${key}» تکراری است.`, path: `items.${index}.key` },
      ])
    }
    item.key = key
    byKey.set(key, item)
  })

  const depthOf = (item: Loose, seen = new Set<string>()): number => {
    const key = String(item.key)
    if (seen.has(key)) {
      failField(collection, req, [
        { message: 'درخت منو دور دارد.', path: 'items' },
      ])
    }
    seen.add(key)

    const parentKey = typeof item.parentKey === 'string' ? item.parentKey.trim() : ''
    if (!parentKey) return 0

    const parent = byKey.get(parentKey)
    if (!parent) {
      failField(collection, req, [
        {
          message: `والد آیتم «${key}» در همین منو نیست.`,
          path: 'items',
        },
      ])
    }

    return depthOf(parent!, seen) + 1
  }

  for (const [index, item] of items.entries()) {
    item.depth = depthOf(item)

    if (item.type === 'reference') {
      const reference = referenceParts(item.reference)
      if (!reference?.value) {
        failField(collection, req, [
          { message: 'سند مقصد آیتم پیوند داخلی را انتخاب کنید.', path: `items.${index}.reference` },
        ])
      }
      if (!(MENU_TARGET_COLLECTIONS as readonly string[]).includes(reference!.relationTo)) {
        failField(collection, req, [
          {
            message: 'مجموعهٔ مقصد این آیتم منو پشتیبانی نمی‌شود.',
            path: `items.${index}.reference`,
          },
        ])
      }
      const target = await findOnSite(
        req,
        reference!.relationTo as MenuTargetCollection,
        reference!.value,
        siteId,
        { id: true } as never,
      )
      if (!target) {
        failField(collection, req, [
          {
            message: 'سند مقصد آیتم منو متعلق به این سایت نیست.',
            path: `items.${index}.reference`,
          },
        ])
      }
      if (item.url && !safeMenuUrl(item.url)) {
        failField(collection, req, [
          { message: 'نشانی آیتم منو باید مسیر داخلی یا نشانی http/https باشد.', path: `items.${index}.url` },
        ])
      }
    } else {
      if (!safeMenuUrl(item.url)) {
        failField(collection, req, [
          { message: 'نشانی آیتم منو باید مسیر داخلی یا نشانی http/https باشد.', path: `items.${index}.url` },
        ])
      }
      item.reference = null
    }
  }

  next.items = items

  return next as typeof data
}
