import { randomInt, randomUUID } from 'node:crypto'
import { expect, request, test } from '@playwright/test'

/**
 * Handler-level tests cannot catch Payload's first-path-segment dispatch rule.
 * Exercise the two POS PUT routes through the actual Next/Payload HTTP router.
 * Run `pnpm seed` first, as with the other API-key end-to-end tests.
 */
test('site-key café sync and authoritative cart checkout work through the HTTP router', async () => {
  const baseURL = 'http://localhost:3000'
  const admin = await request.newContext({ baseURL })
  const anonymous = await request.newContext({ baseURL })
  const sourceId = `e2e-${randomUUID()}`
  const phone = `09${randomInt(100000000, 1000000000)}`
  let keyId: string | undefined
  let orderId: string | undefined
  let legacyOrderId: string | undefined
  let pageId: string | undefined
  let nativeProductId: string | undefined
  let productId: string | undefined
  let termId: string | undefined
  let taxonomyId: string | undefined
  let taxonomyExisted = true

  try {
    const unauthorized = await anonymous.put(`/api/site/cafe-menu/categories/${sourceId}`, { data: { name: 'بدون کلید' } })
    expect(unauthorized.status()).toBe(403)
    const unauthorizedProduct = await anonymous.put(`/api/site/cafe-menu/products/${sourceId}`, { data: { title: 'بدون کلید', price: 1 } })
    expect(unauthorizedProduct.status()).toBe(403)

    expect((await admin.post('/api/users/login', { data: { email: 'admin@eshobe.test', password: 'test1234' } })).status()).toBe(200)
    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const shop = sites.docs.find((site: { domain: string }) => site.domain === 'shop.localhost')
    const otherSite = sites.docs.find((site: { domain: string }) => site.domain === 'acme.localhost')
    expect(shop && otherSite).toBeTruthy()
    const taxonomyQuery = `/api/taxonomy-definitions?depth=0&where[site][equals]=${shop.id}&where[key][equals]=cafe_menu_category`
    const before = await (await admin.get(taxonomyQuery)).json()
    taxonomyExisted = before.docs.length > 0

    const issuedResponse = await admin.post('/api/api-keys/issue', { data: { name: `café e2e ${sourceId}`, role: 'site', siteId: shop.id } })
    expect(issuedResponse.status()).toBe(201)
    const issued = await issuedResponse.json()
    keyId = issued.id
    const headers = { authorization: `Bearer ${issued.key}`, host: 'shop.localhost' }

    // The generic product API is an existing site-key integration too; the
    // earlier site derivation must not make its ordinary draft creates fail.
    const native = await anonymous.post('/api/products?depth=0', { headers, data: {
      title: 'کالای عادی', slug: `native-${sourceId}`, price: 1000, site: otherSite.id,
    } })
    expect(native.status(), await native.text()).toBe(201)
    const nativeDoc = (await native.json()).doc
    nativeProductId = nativeDoc.id
    expect(nativeDoc.site).toBe(shop.id)

    const categoryPath = `/api/site/cafe-menu/categories/${sourceId}`
    const categoryData = { name: 'قهوه', menuOrder: 1 }
    const categoryWrites = await Promise.all([
      anonymous.put(categoryPath, { headers, data: categoryData }),
      anonymous.put(categoryPath, { headers, data: categoryData }),
    ])
    const succeeded = categoryWrites.find((response) => response.status() === 200)
    if (succeeded) termId = (await succeeded.json()).id
    const after = await (await admin.get(taxonomyQuery)).json()
    taxonomyId = after.docs[0]?.id
    expect(categoryWrites.map((response) => response.status())).toContain(200)
    expect(categoryWrites.every((response) => [200, 409].includes(response.status()))).toBe(true)
    const categoryRetry = await anonymous.put(categoryPath, { headers, data: categoryData })
    expect(categoryRetry.status(), await categoryRetry.text()).toBe(200)
    expect((await categoryRetry.json()).id).toBe(termId)

    const body = {
      title: 'لاته', price: 120000, categorySourceIds: [sourceId],
      modifierGroups: [{ sourceId: 'milk', label: 'شیر', minSelections: 1, maxSelections: 1, options: [
        { sourceId: 'oat', label: 'جو', priceDelta: 5000 }, { sourceId: 'dairy', label: 'معمولی', priceDelta: 0 },
      ] }],
    }
    const productPath = `/api/site/cafe-menu/products/${sourceId}`
    const first = await anonymous.put(productPath, { headers, data: body })
    expect(first.status(), await first.text()).toBe(200)
    const created = await first.json()
    productId = created.id
    expect(created.status).toBe('draft')
    const retry = await anonymous.put(productPath, { headers, data: body })
    expect(retry.status(), await retry.text()).toBe(200)
    expect((await retry.json()).id).toBe(productId)

    const publish = await admin.patch(`/api/products/${productId}?depth=0`, { data: { _status: 'published' } })
    expect(publish.status(), await publish.text()).toBe(200)

    const pageSlug = `cafe-${sourceId}`
    const page = await admin.post('/api/pages?depth=0', { data: {
      site: shop.id, title: 'صفحهٔ منوی آزمایشی', slug: pageSlug, _status: 'published',
      hero: { type: 'none' }, layout: [{ blockType: 'productGrid', mode: 'cafe', showBuyButton: true }],
    } })
    expect(page.status(), await page.text()).toBe(201)
    pageId = (await page.json()).doc?.id
    const storefront = await anonymous.get(`/${pageSlug}`, { headers: { host: 'shop.localhost' } })
    expect(storefront.status(), await storefront.text()).toBe(200)
    const html = await storefront.text()
    expect(html).toContain('قهوه')
    expect(html).toContain('لاته')
    expect(html).toContain('شیر')
    expect(html).toContain('جو')

    const checkout = await anonymous.post('/api/checkout', { headers: { host: 'shop.localhost' }, data: {
      name: 'خریدار آزمایشی', phone, total: 1,
      items: [
        { product: productId, quantity: 2, unitPrice: 1, modifiers: [{ groupId: 'milk', optionIds: ['oat'] }] },
        { product: productId, quantity: 1, modifiers: [{ groupId: 'milk', optionIds: ['dairy'] }] },
      ],
    } })
    expect(checkout.status(), await checkout.text()).toBe(200)
    const receipt = await checkout.json()
    orderId = receipt.confirmationUrl?.match(/checkout\/([^?]+)/)?.[1]
    expect(orderId).toBeTruthy()
    const orderResponse = await admin.get(`/api/orders/${orderId}?depth=0`)
    expect(orderResponse.status()).toBe(200)
    const order = await orderResponse.json()
    expect(order.total).toBe(370000)
    expect(order.items.map((line: { unitPrice: number }) => line.unitPrice)).toEqual([125000, 120000])
    expect(order.items[0].modifiers[0]).toMatchObject({ groupSourceId: 'milk', optionSourceId: 'oat', priceDelta: 5000 })

    const legacy = await anonymous.post('/api/checkout', { headers: { host: 'shop.localhost' }, data: {
      name: 'خریدار قدیمی', phone: `09${randomInt(100000000, 1000000000)}`, product: productId, quantity: 1,
      modifiers: [{ groupId: 'milk', optionIds: ['oat'] }],
    } })
    expect(legacy.status(), await legacy.text()).toBe(200)
    legacyOrderId = (await legacy.json()).confirmationUrl?.match(/checkout\/([^?]+)/)?.[1]
    expect(legacyOrderId).toBeTruthy()
  } finally {
    if (orderId) await admin.delete(`/api/orders/${orderId}`)
    if (legacyOrderId) await admin.delete(`/api/orders/${legacyOrderId}`)
    if (pageId) await admin.delete(`/api/pages/${pageId}`)
    if (productId) await admin.delete(`/api/products/${productId}`)
    if (nativeProductId) await admin.delete(`/api/products/${nativeProductId}`)
    if (termId) await admin.delete(`/api/taxonomy-terms/${termId}`)
    if (!taxonomyExisted && taxonomyId) {
      const remaining = await (await admin.get(`/api/taxonomy-terms?limit=1&where[taxonomy][equals]=${taxonomyId}`)).json()
      if (remaining.totalDocs === 0) await admin.delete(`/api/taxonomy-definitions/${taxonomyId}`)
    }
    if (keyId) await admin.post('/api/api-keys/revoke', { data: { id: keyId } })
    await anonymous.dispose()
    await admin.dispose()
  }
})
