// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { createLocalReq, getPayload } from 'payload'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { CafeMenu } from '@/blocks/ProductGrid/CafeMenu'
import { upsertCafeCategory, upsertCafeProduct } from '@/endpoints/cafeMenuSync'
import { startCheckout } from '@/endpoints/checkout'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { idOf } from '@/lib/ids'
import { resetRateLimits } from '@/lib/rate-limit'
import { findForSite } from '@/lib/site-query'
import type { Site } from '@/payload-types'
import { cmsTypedUser } from './cmsUser'

let payload: Payload
let shop: Site
let acme: Site
let shopKey = ''
let acmeKey = ''
let categoryId = ''
let foreignCategoryId = ''
let posProductId = ''
let foreignProductId = ''
let nativeProductId = ''
let orderId = ''
const keyIds: string[] = []
const suffix = randomUUID()
const categorySourceId = `test-coffee-${suffix}`
const productSourceId = `test-product-${suffix}`
const raceCategorySourceId = `test-race-category-${suffix}`
const childCategorySourceId = `test-child-category-${suffix}`
const raceProductSourceId = `test-race-product-${suffix}`
const draftProductSourceId = `test-draft-product-${suffix}`
const bootstrapCategoryA = `test-bootstrap-a-${suffix}`
const bootstrapCategoryB = `test-bootstrap-b-${suffix}`
let existingTaxonomyIds: string[] = []
let originalAcmeLocales: Site['availableLocales']

const modifiers = [{
  sourceId: 'milk', label: 'شیر', minSelections: 1, maxSelections: 1, menuOrder: 2, active: true,
  options: [
    { sourceId: 'oat', label: 'جو', priceDelta: 25, menuOrder: 1, active: true },
    { sourceId: 'dairy', label: 'معمولی', priceDelta: -5, menuOrder: 0, active: true },
    { sourceId: 'retired', label: 'قدیمی', priceDelta: 3, menuOrder: 2, active: false },
  ],
}]

const issueKey = async (siteId: string) => {
  const admin = (await payload.find({ collection: 'users', where: { email: { equals: 'admin@eshobe.test' } }, limit: 1 })).docs[0]!
  expect(admin.role).toBe('platformAdmin')
  const req = await createLocalReq({
    req: { json: async () => ({ name: 'café integration test', role: 'site', siteId }) } as Partial<PayloadRequest>,
    user: cmsTypedUser(admin),
  }, payload)
  const response = await issueApiKeyEndpoint.handler(req)
  expect(response.status).toBe(201)
  const result = await response.json() as { id: string; key: string }
  keyIds.push(result.id)
  return result.key
}

const request = async ({ key, body, sourceId, host = 'admin.localhost', method = 'PUT', path = '/api/site/cafe-menu/products/x' }: {
  key?: string; body: unknown; sourceId?: string; host?: string; method?: string; path?: string
}): Promise<PayloadRequest> => {
  const text = JSON.stringify(body)
  const req = await createLocalReq({ req: {
    body,
    headers: new Headers({ 'content-type': 'application/json', 'content-length': String(text.length), host, ...(key ? { authorization: `Bearer ${key}` } : {}) }),
    method, payloadAPI: 'REST', routeParams: sourceId ? { sourceId } : {}, text: async () => text, url: `http://${host}${path}`,
  } as Partial<PayloadRequest> }, payload)
  req.context.disableRevalidate = true
  return req
}
const syncCategory = async (key: string, sourceId: string, body: object) => {
  const response = await upsertCafeCategory(await request({ key, sourceId, body }))
  return { status: response.status, body: await response.json() as { id?: string; message?: string; ok?: boolean } }
}
const syncProduct = async (key: string, sourceId: string, body: object) => {
  const response = await upsertCafeProduct(await request({ key, sourceId, body }))
  return { status: response.status, body: await response.json() as { id?: string; message?: string; ok?: boolean; status?: string } }
}
const checkout = async (body: object, host = 'shop.localhost') => {
  const req = await request({ body, host, method: 'POST', path: '/api/checkout' })
  return startCheckout(req)
}
const getProduct = (id: string, locale: 'fa' | 'en' = 'fa') => payload.findByID({ collection: 'products', id, depth: 0, locale, overrideAccess: true })
const item = (option: string, quantity = 1) => ({ product: posProductId, quantity, modifiers: [{ groupId: 'milk', optionIds: [option] }] })
const buyer = { name: 'خریدار', phone: '09123456789' }

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const sites = (await payload.find({ collection: 'sites', depth: 0, pagination: false })).docs
  shop = sites.find((site) => site.domain === 'shop.localhost')!
  acme = sites.find((site) => site.domain === 'acme.localhost')!
  expect(shop && acme).toBeTruthy()
  originalAcmeLocales = acme.availableLocales
  await payload.update({ collection: 'sites', id: acme.id, data: { availableLocales: ['fa', 'en'] }, overrideAccess: true, context: { disableRevalidate: true } })
  existingTaxonomyIds = (await payload.find({ collection: 'taxonomy-definitions', depth: 0, overrideAccess: true, pagination: false, where: { key: { equals: 'cafe_menu_category' } } })).docs.map((doc) => String(doc.id))
  shopKey = await issueKey(shop.id)
  acmeKey = await issueKey(acme.id)
  resetRateLimits()
}, 180_000)

afterAll(async () => {
  if (!payload) return
  if (orderId) await payload.delete({ collection: 'orders', id: orderId, overrideAccess: true })
  const syncedProducts = await payload.find({ collection: 'products', depth: 0, overrideAccess: true, pagination: false, where: { menuSourceId: { in: [productSourceId, raceProductSourceId, draftProductSourceId] } } })
  for (const doc of syncedProducts.docs) await payload.delete({ collection: 'products', id: doc.id, overrideAccess: true, context: { disableRevalidate: true } })
  if (nativeProductId) await payload.delete({ collection: 'products', id: nativeProductId, overrideAccess: true, context: { disableRevalidate: true } })
  const terms = await payload.find({ collection: 'taxonomy-terms', depth: 0, overrideAccess: true, pagination: false, where: { menuSourceId: { in: [categorySourceId, raceCategorySourceId, childCategorySourceId, bootstrapCategoryA, bootstrapCategoryB] } } })
  for (const doc of terms.docs) await payload.delete({ collection: 'taxonomy-terms', id: doc.id, overrideAccess: true })
  const taxonomies = await payload.find({ collection: 'taxonomy-definitions', depth: 0, overrideAccess: true, pagination: false, where: { key: { equals: 'cafe_menu_category' } } })
  for (const doc of taxonomies.docs) if (!existingTaxonomyIds.includes(String(doc.id)) && [shop.id, acme.id].includes(String(idOf(doc.site)))) await payload.delete({ collection: 'taxonomy-definitions', id: doc.id, overrideAccess: true })
  for (const id of keyIds) await payload.delete({ collection: 'api-keys', id, overrideAccess: true })
  if (acme && originalAcmeLocales) await payload.update({ collection: 'sites', id: acme.id, data: { availableLocales: originalAcmeLocales }, overrideAccess: true, context: { disableRevalidate: true } })
}, 180_000)

describe.sequential('site-scoped POS café menu', () => {
  it('creates one taxonomy during concurrent first category deliveries', async () => {
    const responses = await Promise.all([
      syncCategory(shopKey, bootstrapCategoryA, { name: 'اول' }),
      syncCategory(shopKey, bootstrapCategoryB, { name: 'دوم' }),
    ])
    expect(responses.map((response) => response.status)).toContain(200)
    expect(responses.every((response) => [200, 409].includes(response.status)), JSON.stringify(responses)).toBe(true)
    expect((await syncCategory(shopKey, bootstrapCategoryA, { name: 'اول' })).status).toBe(200)
    expect((await syncCategory(shopKey, bootstrapCategoryB, { name: 'دوم' })).status).toBe(200)
    expect((await payload.count({ collection: 'taxonomy-definitions', where: { and: [{ site: { equals: shop.id } }, { key: { equals: 'cafe_menu_category' } }] } })).totalDocs).toBe(1)
  })

  it('upserts categories by stable identity, independently per site', async () => {
    expect((await syncCategory('', categorySourceId, { name: 'قهوه' })).status).toBe(403)
    const first = await syncCategory(shopKey, categorySourceId, { name: 'قهوه', menuOrder: 3 })
    expect(first, JSON.stringify(first)).toMatchObject({ status: 200, body: { ok: true } })
    categoryId = first.body.id!
    const retry = await syncCategory(shopKey, categorySourceId, { name: 'نوشیدنی گرم', menuOrder: 1 })
    expect(retry.body.id).toBe(categoryId)
    const foreign = await syncCategory(acmeKey, categorySourceId, { name: 'قهوهٔ سایت دیگر', menuOrder: 2 })
    expect(foreign.status).toBe(200)
    foreignCategoryId = foreign.body.id!
    expect(foreignCategoryId).not.toBe(categoryId)
    const own = await payload.findByID({ collection: 'taxonomy-terms', id: categoryId, depth: 0 })
    expect(own).toMatchObject({ name: 'نوشیدنی گرم', menuOrder: 1, menuSourceId: categorySourceId, menuSourceSystem: 'biza_miz' })
    expect(idOf(own.site)).toBe(shop.id)
    const anon = await findForSite('taxonomy-terms', String(shop.id), { pagination: false, where: { id: { equals: foreignCategoryId } } })
    expect(anon.docs).toHaveLength(0)
  })

  it('handles concurrent first writes and prevents category cycles', async () => {
    const categoryWrites = await Promise.all([
      syncCategory(shopKey, raceCategorySourceId, { name: 'هم‌زمان' }),
      syncCategory(shopKey, raceCategorySourceId, { name: 'هم‌زمان' }),
    ])
    expect(categoryWrites.map((result) => result.status)).toContain(200)
    expect(categoryWrites.every((result) => [200, 409].includes(result.status)), JSON.stringify(categoryWrites)).toBe(true)
    const categoryRetry = await syncCategory(shopKey, raceCategorySourceId, { name: 'هم‌زمان' })
    expect(categoryRetry.status).toBe(200)
    expect((await payload.count({ collection: 'taxonomy-terms', where: { and: [{ site: { equals: shop.id } }, { menuSourceId: { equals: raceCategorySourceId } }] } })).totalDocs).toBe(1)

    const child = await syncCategory(shopKey, childCategorySourceId, { name: 'فرزند', parentSourceId: raceCategorySourceId })
    expect(child.status).toBe(200)
    expect((await syncCategory(shopKey, raceCategorySourceId, { name: 'هم‌زمان', parentSourceId: childCategorySourceId })).status).toBe(400)
    expect((await syncCategory(shopKey, childCategorySourceId, { name: 'فرزند', parentSourceId: null })).status).toBe(200)
    expect((await payload.findByID({ collection: 'taxonomy-terms', id: child.body.id!, depth: 0 })).parent).toBeFalsy()

    const productBody = { title: 'هم‌زمان', price: 42 }
    const productWrites = await Promise.all([
      syncProduct(shopKey, raceProductSourceId, productBody),
      syncProduct(shopKey, raceProductSourceId, productBody),
    ])
    expect(productWrites.map((result) => result.status)).toContain(200)
    expect(productWrites.every((result) => [200, 409].includes(result.status)), JSON.stringify(productWrites)).toBe(true)
    const productRetry = await syncProduct(shopKey, raceProductSourceId, productBody)
    expect(productRetry.status).toBe(200)
    expect((await payload.count({ collection: 'products', where: { and: [{ site: { equals: shop.id } }, { menuSourceId: { equals: raceProductSourceId } }] } })).totalDocs).toBe(1)
  })

  it('creates drafts and retries products without duplicates, preserving modifier identities', async () => {
    const body = { title: 'لاته', summary: 'توضیح', price: 100, menuOrder: 2, menuAvailability: 'available', trackInventory: true, inventory: 5, categorySourceIds: [categorySourceId], modifierGroups: modifiers }
    const first = await syncProduct(shopKey, productSourceId, body)
    expect(first, JSON.stringify(first)).toMatchObject({ status: 200, body: { ok: true, status: 'draft' } })
    posProductId = first.body.id!
    const initial = await getProduct(posProductId)
    expect(initial.externalInventory).toBe(true)
    expect(initial.modifierGroups?.[0]?.sourceId).toBe('milk')
    expect(initial.terms?.map(idOf)).toEqual([categoryId])
    const retry = await syncProduct(shopKey, productSourceId, { ...body, title: 'لاتهٔ تازه', modifierGroups: [{ ...modifiers[0], options: [...modifiers[0]!.options].reverse() }] })
    expect(retry.body.id).toBe(posProductId)
    const updated = await getProduct(posProductId)
    expect(updated.modifierGroups?.[0]?.id).toBe(initial.modifierGroups?.[0]?.id)
    expect(updated.modifierGroups?.[0]?.options?.find((option) => option.sourceId === 'oat')?.id).toBe(initial.modifierGroups?.[0]?.options?.find((option) => option.sourceId === 'oat')?.id)
    expect((await payload.count({ collection: 'products', where: { and: [{ site: { equals: shop.id } }, { menuSourceId: { equals: productSourceId } }] } })).totalDocs).toBe(1)
    const foreign = await syncProduct(acmeKey, productSourceId, { title: 'سایت دیگر', price: 123, categorySourceIds: [categorySourceId] })
    expect(foreign.status).toBe(200)
    foreignProductId = foreign.body.id!
    expect(foreignProductId).not.toBe(posProductId)
    expect((await syncProduct(shopKey, productSourceId, { _status: 'published', title: 'x' })).status).toBe(400)
    await payload.update({ collection: 'products', id: posProductId, data: { _status: 'published' }, overrideAccess: true, context: { disableRevalidate: true } })
    const publishedUpdate = await syncProduct(shopKey, productSourceId, { summary: 'توضیح تازه' })
    expect(publishedUpdate, JSON.stringify(publishedUpdate)).toMatchObject({ status: 200, body: { status: 'published' } })
  })

  it('keeps translations across source-ID-based modifier updates', async () => {
    expect((await syncCategory(shopKey, categorySourceId, { name: 'English', locale: 'en' })).status).toBe(400)
    expect((await syncCategory(acmeKey, categorySourceId, { name: 'Coffee', locale: 'en' })).status).toBe(200)
    expect((await payload.findByID({ collection: 'taxonomy-terms', id: foreignCategoryId, depth: 0, locale: 'fa' })).name).toBe('قهوهٔ سایت دیگر')
    expect((await payload.findByID({ collection: 'taxonomy-terms', id: foreignCategoryId, depth: 0, locale: 'en' })).name).toBe('Coffee')
    const english = await syncProduct(acmeKey, productSourceId, { locale: 'en', title: 'Coffee', modifierGroups: modifiers.map((group) => ({ ...group, label: 'Milk', options: group.options.map((option) => ({ ...option, label: option.sourceId })) })) })
    expect(english, JSON.stringify(english)).toMatchObject({ status: 200 })
    const farsi = await syncProduct(acmeKey, productSourceId, { locale: 'fa', title: 'قهوه', modifierGroups: modifiers })
    expect(farsi, JSON.stringify(farsi)).toMatchObject({ status: 200 })
    const en = await getProduct(foreignProductId, 'en')
    const fa = await getProduct(foreignProductId, 'fa')
    expect(en.modifierGroups?.[0]?.label).toBe('Milk')
    expect(fa.modifierGroups?.[0]?.label).toBe('شیر')
    expect(en.modifierGroups?.[0]?.options?.find((option) => option.sourceId === 'oat')?.label).toBe('oat')
    expect(fa.modifierGroups?.[0]?.options?.find((option) => option.sourceId === 'oat')?.label).toBe('جو')
    expect(en.modifierGroups?.[0]?.id).toBe(fa.modifierGroups?.[0]?.id)
  })

  it('renders only published same-site products, in POS category and product order', async () => {
    expect((await syncProduct(shopKey, raceProductSourceId, { title: 'زودتر', menuOrder: 0, categorySourceIds: [raceCategorySourceId, categorySourceId] })).status).toBe(200)
    const race = await syncProduct(shopKey, raceProductSourceId, { title: 'زودتر' })
    await payload.update({ collection: 'products', id: race.body.id!, data: { _status: 'published' }, overrideAccess: true, context: { disableRevalidate: true } })
    await payload.update({ collection: 'products', id: foreignProductId, data: { _status: 'published' }, overrideAccess: true, context: { disableRevalidate: true } })
    expect((await syncProduct(shopKey, draftProductSourceId, { title: 'فقط پیش نویس', price: 10, categorySourceIds: [categorySourceId] })).status).toBe(200)
    const view = await CafeMenu({ currency: 'IRT', locale: 'fa', paymentMethods: [], showBuyButton: true, siteId: String(shop.id) })
    expect(view).toBeTruthy()
    const html = renderToStaticMarkup(view!)
    expect(html).toContain('لاتهٔ تازه')
    expect(html).toContain('زودتر')
    expect(html).not.toContain('فقط پیش نویس')
    expect(html).not.toContain('>قهوه<')
    expect(html.indexOf('هم‌زمان')).toBeLessThan(html.indexOf('نوشیدنی گرم'))
    expect(html.indexOf('زودتر')).toBeLessThan(html.indexOf('لاتهٔ تازه'))
  })

  it('enforces DB uniqueness and refuses cross-tenant relationships even when the body spoofs site', async () => {
    await expect(payload.create({
      collection: 'products', overrideAccess: true, context: { disableRevalidate: true },
      data: { site: shop.id, title: 'native', slug: `native-stock-test-${suffix}`, price: 1, trackInventory: true, _status: 'published' },
    })).rejects.toThrow()
    const duplicate = payload.create({
      collection: 'products', overrideAccess: true, context: { disableRevalidate: true },
      data: { site: shop.id, title: 'duplicate', slug: `duplicate-menu-test-${suffix}`, price: 100, menuSourceSystem: 'biza_miz', menuSourceId: productSourceId, _status: 'draft' },
    })
    await expect(duplicate).rejects.toThrow()
    const req = await request({ key: shopKey, body: {} })
    await expect(payload.create({
      collection: 'products', req, overrideAccess: false,
      data: { site: acme.id, title: 'spoof', slug: `spoof-menu-test-${suffix}`, price: 1, terms: [foreignCategoryId], _status: 'draft' },
    })).rejects.toThrow()
    const foreignTerm = await payload.findByID({ collection: 'taxonomy-terms', id: foreignCategoryId, depth: 0 })
    await expect(payload.create({
      collection: 'taxonomy-terms', req: await request({ key: shopKey, body: {} }), overrideAccess: false,
      data: { site: acme.id, taxonomy: idOf(foreignTerm.taxonomy)!, name: 'spoof', slug: `spoof-term-test-${suffix}`, source: { system: 'eshobe', mappingStatus: 'manual' } },
    })).rejects.toThrow()
    await expect(payload.update({ collection: 'products', id: posProductId, data: { site: acme.id }, overrideAccess: true, context: { disableRevalidate: true } })).rejects.toThrow()
    await expect(payload.update({ collection: 'products', id: posProductId, data: { site: null }, overrideAccess: true, context: { disableRevalidate: true } })).rejects.toThrow()
    await expect(payload.update({ collection: 'taxonomy-terms', id: categoryId, data: { site: acme.id }, overrideAccess: true })).rejects.toThrow()
    await expect(payload.update({ collection: 'taxonomy-terms', id: categoryId, data: { site: null }, overrideAccess: true })).rejects.toThrow()
    const ownTerm = await payload.findByID({ collection: 'taxonomy-terms', id: categoryId, depth: 0 })
    const ownTaxonomyId = idOf(ownTerm.taxonomy)!
    await expect(payload.update({ collection: 'taxonomy-definitions', id: ownTaxonomyId, data: { site: acme.id }, overrideAccess: true })).rejects.toThrow()
    await expect(payload.update({ collection: 'taxonomy-definitions', id: ownTaxonomyId, data: { key: 'other_key' }, overrideAccess: true })).rejects.toThrow()
    const ownQuery = await findForSite('products', shop.id, { where: { id: { equals: foreignProductId } } })
    expect(ownQuery.docs).toHaveLength(0)
  })

  it('rejects missing, inactive and tampered options, unavailable products, and cross-site IDs', async () => {
    for (const line of [
      { product: posProductId, quantity: 1 },
      item('retired'), item('unknown'),
      { product: posProductId, quantity: 1, modifiers: [{ groupId: 'milk', optionIds: ['oat', 'dairy'] }] },
      { product: posProductId, quantity: 1, modifiers: [{ groupId: 'milk', optionIds: ['oat', 'oat'] }] },
      { product: foreignProductId, quantity: 1 },
    ]) expect((await checkout({ ...buyer, items: [line] })).status).toBeGreaterThanOrEqual(400)
    expect((await checkout({ ...buyer, items: [item('oat', 3), item('dairy', 3)] })).status).toBe(409)
    expect((await syncProduct(shopKey, productSourceId, { modifierGroups: [{ ...modifiers[0], active: 'false' }] })).status).toBe(400)
    expect((await syncProduct(shopKey, productSourceId, { inventory: null, trackInventory: true })).status).toBe(200)
    expect((await checkout({ ...buyer, items: [item('oat')] })).status).toBe(409)
    expect((await syncProduct(shopKey, productSourceId, { inventory: 5, trackInventory: true })).status).toBe(200)
    expect((await syncProduct(shopKey, productSourceId, { menuAvailability: 'sold_out' })).status).toBe(200)
    expect((await checkout({ ...buyer, items: [item('oat')] })).status).toBe(409)
    expect((await syncProduct(shopKey, productSourceId, { menuAvailability: 'unavailable' })).status).toBe(200)
    expect((await checkout({ ...buyer, product: posProductId, quantity: 1 })).status).toBe(409)
    expect((await syncProduct(shopKey, productSourceId, { menuAvailability: 'available' })).status).toBe(200)
    expect((await checkout({ ...buyer, items: [item('oat', 3), item('dairy', 3)] })).status).toBe(409)
  })

  it('prices a mixed multi-item cart from current server data and snapshots modifiers', async () => {
    const native = await payload.create({ collection: 'products', overrideAccess: true, context: { disableRevalidate: true },
      data: { site: shop.id, title: 'کیک', slug: `cafe-native-cake-${suffix}`, price: 200, trackInventory: true, inventory: 5, _status: 'published' } })
    nativeProductId = native.id
    const response = await checkout({ ...buyer, total: 1, items: [
      { ...item('oat'), unitPrice: 1 }, { ...item('dairy', 2), price: 1 }, { product: native.id, quantity: 1, price: 1 },
    ] })
    const body = await response.json() as { confirmationUrl?: string; message?: string }
    expect(response.status, JSON.stringify(body)).toBe(200)
    orderId = body.confirmationUrl!.match(/checkout\/([^?]+)/)![1]!
    const order = await payload.findByID({ collection: 'orders', id: orderId, depth: 0, overrideAccess: true })
    expect(order.total).toBe(515)
    expect(order.items?.map((line) => line.unitPrice)).toEqual([125, 95, 200])
    expect(order.items?.map((line) => line.externalInventory)).toEqual([true, true, false])
    expect(order.items?.[0]?.modifiers?.[0]).toMatchObject({ groupSourceId: 'milk', groupLabel: 'شیر', optionSourceId: 'oat', optionLabel: 'جو', priceDelta: 25, quantity: 1 })
    expect(order.product).toBe(posProductId)

    const renamed = await syncProduct(shopKey, productSourceId, { price: 150, modifierGroups: [{ ...modifiers[0], label: 'شیر جدید', options: modifiers[0]!.options.map((option) => ({ ...option, label: 'تغییر', priceDelta: 50 })) }] })
    expect(renamed.status).toBe(200)
    const historical = await payload.findByID({ collection: 'orders', id: orderId, depth: 0, overrideAccess: true })
    expect(historical.total).toBe(515)
    expect(historical.items?.[0]?.modifiers?.[0]).toMatchObject({ groupLabel: 'شیر', optionLabel: 'جو', priceDelta: 25 })
  })

  it('never decrements POS projections on payment/refund, while ordinary stock still settles', async () => {
    await expect(payload.update({ collection: 'products', id: posProductId, data: { inventory: 999 }, overrideAccess: true, context: { disableRevalidate: true } })).rejects.toThrow()
    expect((await getProduct(posProductId)).inventory).toBe(5)
    const existingOrder = await payload.findByID({ collection: 'orders', id: orderId, depth: 0 })
    const tampered = existingOrder.items!.map((line) => idOf(line.product) === nativeProductId ? { ...line, externalInventory: true } : line)
    await payload.update({ collection: 'orders', id: orderId, data: { items: tampered }, overrideAccess: true, context: { disableRevalidate: true } })
    const secured = await payload.findByID({ collection: 'orders', id: orderId, depth: 0 })
    expect(secured.items?.find((line) => idOf(line.product) === nativeProductId)?.externalInventory).toBe(false)
    await payload.update({ collection: 'orders', id: orderId, data: { status: 'paid' }, overrideAccess: true, context: { disableRevalidate: true } })
    expect((await getProduct(posProductId)).inventory).toBe(5)
    expect((await getProduct(nativeProductId)).inventory).toBe(4)
    await payload.update({ collection: 'orders', id: orderId, data: { status: 'refunded' }, overrideAccess: true, context: { disableRevalidate: true } })
    expect((await getProduct(posProductId)).inventory).toBe(5)
    expect((await getProduct(nativeProductId)).inventory).toBe(5)
    expect((await syncProduct(shopKey, productSourceId, { inventory: 4, trackInventory: true })).status).toBe(200)
    expect((await getProduct(posProductId)).inventory).toBe(4)
  })
})
