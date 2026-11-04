/**
 * CMS catalogue → Torob v3 records. Pure where possible: the endpoint reads one site's
 * published rows through `findForSite`, then this module decides what may be sent.
 *
 * Money conversion delegates to `src/lib/money.ts` (the only place IRR→IRT lives).
 * Images use the original public upload URL and verified dimensions, never a thumbnail
 * or a tenant-authenticated media route.
 */
import { isIP } from 'node:net'

import type { Media, Product, Site } from '@/payload-types'

import { isPrivateAddress } from '@/payments/gateways/net'
import { idOf } from '@/lib/ids'
import { rialToToman } from '@/lib/money'
import { PRODUCTS_BASE } from '@/lib/slug'
import { siteUrl } from '@/lib/site-url'

import {
  TOROB_CURSOR_SORT,
  TOROB_FIELD_LIMITS,
  TOROB_PAGE_SIZE,
  clampTorobField,
  isAbsoluteHttpUrl,
  torobCursorResponse,
  torobPageResponse,
  torobPricePair,
  type TorobProductV3,
  type TorobRequest,
  type TorobSort,
  type TorobV3Response,
} from './contract'

export const TOROB_MIN_IMAGE_EDGE = 600
export const TOROB_MAX_PRICE_TOMAN = 100_000_000_000
const CURSOR_PREFIX = 'torob-cursor-v1:'

export type TorobSkipReason =
  | 'duplicate_page'
  | 'missing_date'
  | 'missing_image'
  | 'missing_title'
  | 'not_sellable'
  | 'price_not_whole_toman'
  | 'unusable_url'

export type TorobBuiltFeed = {
  items: TorobProductV3[]
  skipped: { pageUnique: string; reason: TorobSkipReason }[]
}

const iso = (value: null | string | undefined): null | string => {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Exact integer Toman, or null. Never rounds, never guesses an unsupported currency. */
export const torobToman = (amount: unknown, currency: string): null | number => {
  if (currency !== 'IRT' && currency !== 'IRR') return null
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return null
  let toman: number
  try {
    toman = currency === 'IRR' ? rialToToman(amount) : amount
  } catch {
    return null
  }
  return Number.isSafeInteger(toman) && toman <= TOROB_MAX_PRICE_TOMAN ? toman : null
}

const publicUrl = (raw: null | string | undefined, origin: string): null | string => {
  if (!raw) return null
  const value = raw.trim()
  if (!value || value.length > TOROB_FIELD_LIMITS.page_url) return null
  try {
    const url = value.startsWith('/') && !value.startsWith('//') ? new URL(value, origin) : new URL(value)
    if (!isAbsoluteHttpUrl(url.href)) return null
    if (url.username || url.password) return null
    const host = url.hostname.replace(/^\[|\]$/g, '')
    // A hostname is not resolved here (no outbound fetch per crawl); IP literals are
    // range-checked, and relative CMS media URLs are anchored to the public site origin.
    if (isIP(host) && isPrivateAddress(host)) return null
    return url.href
  } catch {
    return null
  }
}

const imageLinks = (product: Product, site: Site, origin: string): string[] => {
  const candidates: unknown[] = [product.image, ...(product.gallery ?? [])]
  const links: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const media = candidate as Media
    if (idOf(media.site) !== idOf(site.id)) continue
    if (typeof media.mimeType !== 'string' || !media.mimeType.startsWith('image/')) continue
    if (media.mimeType === 'image/svg+xml') continue
    if (
      typeof media.width !== 'number' ||
      typeof media.height !== 'number' ||
      media.width < TOROB_MIN_IMAGE_EDGE ||
      media.height < TOROB_MIN_IMAGE_EDGE
    ) {
      continue
    }
    const url = publicUrl(media.url, origin)
    if (!url || url.length > TOROB_FIELD_LIMITS.image_link || seen.has(url)) continue
    seen.add(url)
    links.push(url)
  }
  return links
}

const specOf = (product: Product, variation?: NonNullable<Product['variations']>[number]) => {
  const spec: Record<string, number | string> = {}
  for (const attribute of product.attributes ?? []) {
    const name = (attribute.name ?? attribute.key ?? '').trim()
    if (!name) continue
    const selected = variation?.attributeValues
    if (selected && typeof selected === 'object' && !Array.isArray(selected)) {
      const value = (selected as Record<string, unknown>)[attribute.key ?? '']
      if (typeof value === 'string' || typeof value === 'number') {
        spec[name] = value
        continue
      }
    }
    const options = (attribute.options ?? [])
      .map((option) => option.value)
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    if (options.length) spec[name] = options.join('، ')
  }
  return spec
}

const inStock = (row: { inventory?: null | number; trackInventory?: null | boolean }): boolean =>
  !(row.trackInventory && typeof row.inventory === 'number' && row.inventory <= 0)

/**
 * Build the whole publishable feed in canonical identity order. Paging cuts this list;
 * skipped rows never inflate `total` or shift a page boundary.
 */
export const buildTorobCmsFeed = (input: {
  currency: string
  origin: string
  products: readonly Product[]
  site: Site
}): TorobBuiltFeed => {
  const items: TorobProductV3[] = []
  const skipped: TorobBuiltFeed['skipped'] = []
  const seenUniques = new Set<string>()
  const seenUrls = new Set<string>()
  const skip = (pageUnique: string, reason: TorobSkipReason) => skipped.push({ pageUnique, reason })

  for (const product of input.products) {
    const id = String(product.id)
    if (product._status !== 'published') {
      skip(id, 'not_sellable')
      continue
    }
    const productType = product.productType ?? 'simple'
    if (productType === 'grouped' || productType === 'external') {
      skip(id, 'not_sellable')
      continue
    }
    const title = clampTorobField(product.title, TOROB_FIELD_LIMITS.title)
    if (!title) {
      skip(id, 'missing_title')
      continue
    }
    const dateAdded = iso(product.createdAt)
    if (!dateAdded) {
      skip(id, 'missing_date')
      continue
    }
    const baseUrl = siteUrl(input.site, {
      base: PRODUCTS_BASE,
      locale: input.site.defaultLocale,
      origin: input.origin,
      slug: product.slug,
    })
    const images = imageLinks(product, input.site, input.origin)
    const variations =
      productType === 'variable'
        ? (product.variations ?? []).filter((variation) => variation.active !== false && variation.key)
        : [null]
    if (productType === 'variable' && variations.length === 0) {
      skip(id, 'not_sellable')
      continue
    }

    for (const variation of variations) {
      const pageUnique = variation ? `${id}~${variation.key}` : id
      if (pageUnique.length > TOROB_FIELD_LIMITS.page_unique) {
        skip(pageUnique, 'unusable_url')
        continue
      }
      let pageUrl = publicUrl(baseUrl, input.origin)
      if (pageUrl && variation) {
        const url = new URL(pageUrl)
        url.searchParams.set('variant', variation.key!)
        pageUrl = url.href
      }
      if (!pageUrl) {
        skip(pageUnique, 'unusable_url')
        continue
      }
      if (!images.length) {
        skip(pageUnique, 'missing_image')
        continue
      }
      if (seenUniques.has(pageUnique) || seenUrls.has(pageUrl)) {
        skip(pageUnique, 'duplicate_page')
        continue
      }
      const amount = variation ? variation.price : product.price
      const toman = torobToman(amount, input.currency)
      if (toman === null) {
        skip(pageUnique, 'price_not_whole_toman')
        continue
      }
      // CMS checkout refuses a zero unit price, so an "available" free row is not a
      // sellable CMS product. Omit it rather than send Torob the free-product signal.
      if (toman === 0 && inStock(variation ?? product)) {
        skip(pageUnique, 'not_sellable')
        continue
      }
      // Checkout reads the variation's stock first and falls back to the parent's
      // only when the variation does not track its own. Mirror that exactly.
      const availableFinal = variation
        ? variation.trackInventory
          ? inStock(variation)
          : inStock(product)
        : inStock(product)
      const item: TorobProductV3 = {
        ...torobPricePair(availableFinal, toman),
        date_added: dateAdded,
        image_links: images,
        page_unique: pageUnique,
        page_url: pageUrl,
        spec: specOf(product, variation ?? undefined),
        title,
      }
      const subtitle = clampTorobField(product.summary, TOROB_FIELD_LIMITS.subtitle)
      if (subtitle) item.subtitle = subtitle
      if (variation) item.product_group_id = clampTorobField(id, TOROB_FIELD_LIMITS.product_group_id)
      const shortDesc = clampTorobField(product.summary, TOROB_FIELD_LIMITS.short_desc)
      if (shortDesc) item.short_desc = shortDesc
      const dateUpdated = iso(product.updatedAt)
      if (dateUpdated) item.date_updated = dateUpdated
      const compareAt = variation ? variation.compareAtPrice : product.compareAtPrice
      const oldToman = torobToman(compareAt, input.currency)
      if (availableFinal && oldToman !== null && oldToman > toman && toman > 0) item.old_price = oldToman
      const category = clampTorobField(
        typeof product.terms?.[0] === 'object' ? product.terms[0]?.name : null,
        TOROB_FIELD_LIMITS.category_name,
      )
      if (category) item.category_name = category

      seenUniques.add(pageUnique)
      seenUrls.add(pageUrl)
      items.push(item)
    }
  }

  items.sort((a, b) => cmp(a.page_unique, b.page_unique))
  skipped.sort((a, b) => cmp(a.pageUnique, b.pageUnique))
  return { items, skipped }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const sortTorobProducts = (items: readonly TorobProductV3[], sort: TorobSort): TorobProductV3[] => {
  const byUnique = (a: TorobProductV3, b: TorobProductV3) => cmp(a.page_unique, b.page_unique)
  const copy = [...items]
  switch (sort) {
    case 'date_added_desc':
      return copy.sort((a, b) => cmp(b.date_added, a.date_added) || byUnique(a, b))
    case 'date_updated_desc':
      return copy.sort((a, b) => {
        if (!a.date_updated && !b.date_updated) return byUnique(a, b)
        if (!a.date_updated) return 1
        if (!b.date_updated) return -1
        return cmp(b.date_updated, a.date_updated) || byUnique(a, b)
      })
    case 'product_id_desc':
      return copy.sort((a, b) => cmp(b.page_unique, a.page_unique))
  }
}

export const encodeTorobCursor = (pageUnique: string): string =>
  Buffer.from(`${CURSOR_PREFIX}${pageUnique}`, 'utf8').toString('base64url')

export const decodeTorobCursor = (cursor: string): null | string => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    if (!decoded.startsWith(CURSOR_PREFIX)) return null
    const unique = decoded.slice(CURSOR_PREFIX.length)
    return unique && unique.length <= TOROB_FIELD_LIMITS.page_unique ? unique : null
  } catch {
    return null
  }
}

export const serveTorobFeed = (feed: TorobBuiltFeed, request: TorobRequest): TorobV3Response => {
  if (request.mode === 'page_urls' || request.mode === 'page_uniques') {
    const wanted = new Set(
      request.mode === 'page_urls'
        ? request.pageUrls.map((url) => url.trim())
        : request.pageUniques,
    )
    const products = feed.items.filter((item) =>
      wanted.has(request.mode === 'page_urls' ? item.page_url : item.page_unique),
    )
    return torobPageResponse({ page: 1, products, total: products.length })
  }

  const sorted = sortTorobProducts(feed.items, request.sort)
  const total = sorted.length
  if (request.mode === 'page') {
    const maxPage = torobMaxPagesLocal(total)
    const page = Math.min(maxPage, request.page)
    const start = (page - 1) * TOROB_PAGE_SIZE
    return torobPageResponse({ page, products: sorted.slice(start, start + TOROB_PAGE_SIZE), total })
  }

  const after = request.cursor ? decodeTorobCursor(request.cursor) : null
  const start = after ? sorted.findIndex((item) => cmp(item.page_unique, after) < 0) : 0
  if (start === -1) return torobCursorResponse({ nextCursor: null, products: [], total })
  const products = sorted.slice(start, start + TOROB_PAGE_SIZE)
  const last = products[products.length - 1]?.page_unique
  const nextCursor =
    products.length === TOROB_PAGE_SIZE && start + TOROB_PAGE_SIZE < total && last
      ? encodeTorobCursor(last)
      : null
  return torobCursorResponse({ nextCursor, products, total })
}

const torobMaxPagesLocal = (total: number) => Math.max(1, Math.ceil(total / TOROB_PAGE_SIZE))

export const torobCursorSort = TOROB_CURSOR_SORT
