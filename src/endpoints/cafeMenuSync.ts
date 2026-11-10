import type { Endpoint, PayloadRequest, TypedLocale } from 'payload'

import { createHash } from 'node:crypto'
import { addDataAndFileToRequest, ValidationError } from 'payload'

import type { Product, Site, TaxonomyTerm } from '@/payload-types'

import { isMenuSourceId } from '@/collections/hooks/validateMenuSource'
import { CAFE_MENU_TAXONOMY } from '@/lib/cafe-menu'
import { idOf, isUuid } from '@/lib/ids'
import { isLocale } from '@/lib/locales'
import { siteForDomainKey } from './updateSiteDomain'

/** These routes are site-key-only, on the control plane, not a public Caddy carve-out. */
const SYSTEM = 'biza_miz'
const headers = { 'cache-control': 'no-store' }
const answer = (body: object, status = 200) => Response.json(body, { headers, status })
const invalid = (message: string) => answer({ message, ok: false }, 400)
const stableSlug = (kind: string, id: string) =>
  `${kind}-${createHash('sha256').update(id).digest('hex').slice(0, 24)}`


type Context = { body: Record<string, unknown>; locale: TypedLocale; site: Site; sourceId: string }
const contextFor = async (req: PayloadRequest): Promise<Context | Response> => {
  const site = await siteForDomainKey(req)
  if (!site) return answer({ message: 'این عملیات فقط با کلید سایت ممکن است.', ok: false }, 403)
  const sourceId = (req.routeParams as Record<string, unknown> | undefined)?.sourceId
  if (!isMenuSourceId(sourceId)) return invalid('شناسهٔ مبدأ نامعتبر است.')
  try {
    await addDataAndFileToRequest(req)
  } catch {
    return invalid('بدنهٔ JSON نامعتبر است.')
  }
  if (!req.data || typeof req.data !== 'object' || Array.isArray(req.data)) return invalid('بدنهٔ JSON نامعتبر است.')
  const body = req.data as Record<string, unknown>
  if (['_status', 'site', 'menuSourceSystem', 'menuSourceId', 'externalInventory'].some((key) => key in body)) {
    return invalid('سایت، شناسه و وضعیت انتشار را نمی‌توان در بدنه تعیین کرد.')
  }
  const locale = body.locale ?? site.defaultLocale ?? 'fa'
  const availableLocales: readonly string[] = [site.defaultLocale ?? 'fa', ...(site.availableLocales ?? [])]
  if (typeof locale !== 'string' || !isLocale(locale) || !availableLocales.includes(locale)) {
    return invalid('زبان برای این سایت فعال نیست.')
  }
  return { body, locale: locale as TypedLocale, site, sourceId }
}

const findTaxonomy = async (req: PayloadRequest, siteId: string) => {
  const { docs } = await req.payload.find({
    collection: 'taxonomy-definitions', depth: 0, limit: 1, overrideAccess: true, req,
    where: { and: [{ site: { equals: siteId } }, { key: { equals: CAFE_MENU_TAXONOMY } }] },
  })
  return docs[0]
}

const ensureTaxonomy = async (req: PayloadRequest, siteId: string) => {
  const existing = await findTaxonomy(req, siteId)
  if (existing) return existing
  // The reserved identity has a site-scoped DB unique index. Concurrent first
  // writes can conflict; retrying then finds the winner instead of creating one.
  return req.payload.create({
    collection: 'taxonomy-definitions', depth: 0, locale: 'fa', overrideAccess: false, req,
    data: {
      hasArchive: false, hierarchical: true, key: CAFE_MENU_TAXONOMY,
      pluralLabel: 'دسته‌های منوی کافه', singularLabel: 'دستهٔ منوی کافه', site: siteId,
      source: { system: 'eshobe', mappingStatus: 'manual' },
    },
  })
}

const findTerm = async (req: PayloadRequest, siteId: string, sourceId: string): Promise<TaxonomyTerm | undefined> => {
  const { docs } = await req.payload.find({
    collection: 'taxonomy-terms', depth: 0, limit: 1, overrideAccess: true, req,
    where: { and: [
      { site: { equals: siteId } }, { menuSourceSystem: { equals: SYSTEM } }, { menuSourceId: { equals: sourceId } },
    ] },
  })
  return docs[0]
}

const errorResponse = (error: unknown): Response => {
  let current: unknown = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    const candidate = current as { cause?: unknown; code?: string; data?: { errors?: { path?: string }[] }; name?: string }
    if (candidate.code === '23505') return answer({ message: 'همگام‌سازی هم‌زمان بود؛ درخواست را دوباره بفرستید.', ok: false }, 409)
    if (current instanceof ValidationError || candidate.name === 'ValidationError') {
      // Payload's PostgreSQL adapter converts a 23505 into a ValidationError
      // and reports the unique-index columns as a comma-separated field path.
      const conflict = candidate.data?.errors?.some(({ path }) => {
        const fields = path?.split(',').map((field) => field.trim()) ?? []
        return (fields.includes('site_id') && fields.includes('menu_source_system') && fields.includes('menu_source_id')) ||
          (fields.includes('site_id') && fields.includes('cafe_menu_identity')) || path === 'slug' || path === 'key'
      })
      return conflict
        ? answer({ message: 'همگام‌سازی هم‌زمان بود؛ درخواست را دوباره بفرستید.', ok: false }, 409)
        : invalid('داده‌های منو معتبر نیستند.')
    }
    current = candidate.cause
  }
  throw error
}

export const upsertCafeCategory: Endpoint['handler'] = async (req) => {
  const ctx = await contextFor(req)
  if (ctx instanceof Response) return ctx
  const { body, locale, site, sourceId } = ctx
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 200) return invalid('نام دسته لازم است.')
  if (body.description != null && typeof body.description !== 'string') return invalid('توضیح دسته نامعتبر است.')
  if (body.menuOrder != null && !Number.isSafeInteger(body.menuOrder)) return invalid('ترتیب دسته نامعتبر است.')
  if (body.parentSourceId != null && !isMenuSourceId(body.parentSourceId)) return invalid('شناسهٔ دستهٔ والد نامعتبر است.')
  try {
    const taxonomy = await ensureTaxonomy(req, String(site.id))
    const existing = await findTerm(req, String(site.id), sourceId)
    if (existing && idOf(existing.taxonomy) !== String(taxonomy.id)) return answer({ message: 'شناسهٔ دسته به طبقه‌بندی دیگری تعلق دارد.', ok: false }, 409)
    const parent = body.parentSourceId ? await findTerm(req, String(site.id), String(body.parentSourceId)) : null
    if (body.parentSourceId && (!parent || idOf(parent.taxonomy) !== String(taxonomy.id))) return invalid('دستهٔ والد در این سایت پیدا نشد.')
    // A direct or indirect cycle can break taxonomy traversal elsewhere. Treat an
    // already-corrupt, cross-site or unreasonably deep ancestor chain as invalid.
    let ancestor = parent
    const visited = new Set<string>()
    while (ancestor) {
      const ancestorId = String(ancestor.id)
      if (ancestorId === String(existing?.id) || visited.has(ancestorId) || visited.size >= 100) return invalid('دستهٔ والد چرخه یا عمق نامعتبر دارد.')
      if (idOf(ancestor.site) !== String(site.id) || idOf(ancestor.taxonomy) !== String(taxonomy.id)) return invalid('دستهٔ والد در این سایت پیدا نشد.')
      visited.add(ancestorId)
      const nextId = idOf(ancestor.parent)
      ancestor = nextId ? await req.payload.findByID({ collection: 'taxonomy-terms', id: nextId, depth: 0, overrideAccess: true, req }).catch(() => null) : null
      if (nextId && !ancestor) return invalid('دستهٔ والد در این سایت پیدا نشد.')
    }
    const data = {
      name,
      ...(body.description !== undefined ? { description: body.description as string | null } : {}),
      ...(body.menuOrder !== undefined ? { menuOrder: body.menuOrder as number } : {}),
      ...(body.parentSourceId !== undefined ? { parent: parent?.id ?? null } : {}),
      menuSourceId: sourceId, menuSourceSystem: SYSTEM, site: site.id,
      slug: stableSlug('cafe-category', sourceId), taxonomy: taxonomy.id,
    }
    const doc = existing
      ? await req.payload.update({ collection: 'taxonomy-terms', id: existing.id, data, depth: 0, locale, overrideAccess: false, req })
      : await req.payload.create({ collection: 'taxonomy-terms', data: { ...data, source: { system: 'eshobe', mappingStatus: 'manual' } }, depth: 0, locale, overrideAccess: false, req })
    return answer({ id: doc.id, ok: true })
  } catch (error) {
    return errorResponse(error)
  }
}

/** Keep Payload row IDs on stable source IDs so updates in one locale don't discard translations in another. */
const modifiersWithExistingIds = (input: unknown, previous: Product['modifierGroups']): Product['modifierGroups'] | null => {
  if (!Array.isArray(input) || input.length > 50) return null
  const result: NonNullable<Product['modifierGroups']> = []
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const group = value as Record<string, unknown>
    if (!isMenuSourceId(group.sourceId) || typeof group.label !== 'string' || !group.label.trim() || !Array.isArray(group.options) || group.options.length > 100 || (group.active !== undefined && typeof group.active !== 'boolean')) return null
    const old = previous?.find((candidate) => candidate.sourceId === group.sourceId)
    const options: NonNullable<NonNullable<Product['modifierGroups']>[number]['options']> = []
    for (const value of group.options) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const option = value as Record<string, unknown>
      if (!isMenuSourceId(option.sourceId) || typeof option.label !== 'string' || !option.label.trim() || !Number.isSafeInteger(option.priceDelta) || (option.active !== undefined && typeof option.active !== 'boolean')) return null
      const oldOption = old?.options?.find((candidate) => candidate.sourceId === option.sourceId)
      options.push({
        ...(oldOption?.id ? { id: oldOption.id } : {}),
        sourceId: option.sourceId, label: option.label.trim(), priceDelta: option.priceDelta as number,
        active: option.active !== false, menuOrder: (option.menuOrder ?? 0) as number,
      })
    }
    result.push({
      ...(old?.id ? { id: old.id } : {}),
      sourceId: group.sourceId, label: group.label.trim(), minSelections: (group.minSelections ?? 0) as number,
      maxSelections: (group.maxSelections ?? 1) as number, active: group.active !== false,
      menuOrder: (group.menuOrder ?? 0) as number, options,
    })
  }
  return result
}

export const upsertCafeProduct: Endpoint['handler'] = async (req) => {
  const ctx = await contextFor(req)
  if (ctx instanceof Response) return ctx
  const { body, locale, site, sourceId } = ctx
  const siteId = String(site.id)
  if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) return invalid('عنوان کالا نامعتبر است.')
  if (body.summary != null && typeof body.summary !== 'string') return invalid('توضیح کالا نامعتبر است.')
  if (body.sku != null && typeof body.sku !== 'string') return invalid('کد کالا نامعتبر است.')
  if (body.image != null && !isUuid(body.image)) return invalid('شناسهٔ تصویر نامعتبر است.')
  if (body.price !== undefined && (!Number.isSafeInteger(body.price) || Number(body.price) < 0)) return invalid('قیمت نامعتبر است.')
  if (body.menuOrder != null && !Number.isSafeInteger(body.menuOrder)) return invalid('ترتیب کالا نامعتبر است.')
  if (body.menuAvailability !== undefined && !['available', 'sold_out', 'unavailable'].includes(String(body.menuAvailability))) return invalid('وضعیت منو نامعتبر است.')
  if (body.trackInventory !== undefined && typeof body.trackInventory !== 'boolean') return invalid('وضعیت موجودی نامعتبر است.')
  if (body.inventory != null && (!Number.isSafeInteger(body.inventory) || Number(body.inventory) < 0)) return invalid('موجودی نامعتبر است.')
  if (body.categorySourceIds !== undefined && (!Array.isArray(body.categorySourceIds) || body.categorySourceIds.length > 100 || !body.categorySourceIds.every(isMenuSourceId) || new Set(body.categorySourceIds).size !== body.categorySourceIds.length)) return invalid('دسته‌های کالا نامعتبرند.')
  try {
    const { docs } = await req.payload.find({
      collection: 'products', depth: 0, limit: 1, locale, overrideAccess: true, req,
      where: { and: [{ site: { equals: siteId } }, { menuSourceSystem: { equals: SYSTEM } }, { menuSourceId: { equals: sourceId } }] },
    })
    const existing = docs[0]
    if (!existing && (typeof body.title !== 'string' || body.price === undefined)) return invalid('عنوان و قیمت برای کالای جدید لازم است.')
    const modifiers = body.modifierGroups === undefined ? undefined : modifiersWithExistingIds(body.modifierGroups, existing?.modifierGroups)
    if (modifiers === null) return invalid('افزودنی‌ها نامعتبرند.')
    let terms: string[] | undefined
    if (Array.isArray(body.categorySourceIds)) {
      const taxonomy = await ensureTaxonomy(req, siteId)
      terms = []
      // Preserve unrelated product taxonomies when the POS changes menu categories.
      for (const value of existing?.terms ?? []) {
        const termId = idOf(value)
        if (!termId) continue
        const { docs: current } = await req.payload.find({
          collection: 'taxonomy-terms', depth: 0, limit: 1, overrideAccess: true, req,
          where: { and: [{ id: { equals: termId } }, { site: { equals: siteId } }] },
        })
        if (current[0] && idOf(current[0].taxonomy) !== String(taxonomy.id)) terms.push(termId)
      }
      for (const categoryId of body.categorySourceIds as string[]) {
        const term = await findTerm(req, siteId, categoryId)
        if (!term || idOf(term.taxonomy) !== String(taxonomy.id)) return invalid('دستهٔ منو در این سایت پیدا نشد.')
        terms.push(String(term.id))
      }
    }
    const data = {
      ...(body.title !== undefined ? { title: (body.title as string).trim() } : {}),
      ...(body.summary !== undefined ? { summary: body.summary as string | null } : {}),
      ...(body.image !== undefined ? { image: body.image as string | null } : {}),
      ...(body.sku !== undefined ? { sku: body.sku as string | null } : {}),
      ...(body.price !== undefined ? { price: body.price as number } : {}),
      ...(body.menuOrder !== undefined ? { menuOrder: body.menuOrder as number } : {}),
      ...(body.menuAvailability !== undefined ? { menuAvailability: body.menuAvailability as Product['menuAvailability'] } : {}),
      ...(body.trackInventory !== undefined ? { trackInventory: body.trackInventory as boolean } : {}),
      ...(body.inventory !== undefined ? { inventory: body.inventory as number | null } : {}),
      ...(modifiers !== undefined ? { modifierGroups: modifiers } : {}),
      ...(terms !== undefined ? { terms } : {}),
      menuSourceId: sourceId, menuSourceSystem: SYSTEM, site: site.id,
      // Required localized slugs need an explicit value the first time a second
      // locale is synced. Preserve that locale's existing slug (or its fallback).
      slug: existing?.slug ?? stableSlug('cafe-item', sourceId),
    }
    const doc = existing
      ? await req.payload.update({ collection: 'products', id: existing.id, data, depth: 0, locale, overrideAccess: false, req })
      : await req.payload.create({ collection: 'products', data: { ...data, title: data.title!, price: data.price!, slug: stableSlug('cafe-item', sourceId), _status: 'draft' }, depth: 0, locale, overrideAccess: false, req })
    return answer({ id: doc.id, ok: true, status: doc._status })
  } catch (error) {
    return errorResponse(error)
  }
}

export const cafeMenuSyncEndpoints: Endpoint[] = [
  { handler: upsertCafeCategory, method: 'put', path: '/site/cafe-menu/categories/:sourceId' },
  { handler: upsertCafeProduct, method: 'put', path: '/site/cafe-menu/products/:sourceId' },
]
