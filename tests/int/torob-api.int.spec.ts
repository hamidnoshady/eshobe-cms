// @vitest-environment node
import type { Payload } from 'payload'

import { generateKeyPairSync, sign as cryptoSign, createHmac } from 'node:crypto'
import { randomUUID } from 'node:crypto'

import sharp from 'sharp'
import { getPayload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Site } from '@/payload-types'
import config from '@/payload.config'
import { handleTorobProductRequest } from '@/lib/torob/product-api'
import { resetRateLimits } from '@/lib/rate-limit'
import { encodeTorobCursor } from '@/lib/torob/feed'

/**
 * Issue #183 — the site-origin Torob Product API v3 endpoint, on a real CMS database.
 *
 * Two enrolled store fixtures prove the tenant boundary: a token minted for shop A
 * cannot read shop B, and neither shop's feed contains the other's products or media.
 * Run `pnpm seed` first; this file creates and removes its own sites/products/media.
 */

let payload: Payload
const pair = generateKeyPairSync('ed25519')
const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const stranger = generateKeyPairSync('ed25519')

const siteIds: string[] = []
const productIds: string[] = []
const mediaIds: string[] = []

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function mint(aud: string, options: { exp?: number; nbf?: number; key?: typeof pair.privateKey; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: options.alg ?? 'EdDSA', typ: 'JWT', v: 1 })
  const payloadPart = b64({ aud, exp: options.exp ?? now + 300, nbf: options.nbf ?? now - 5, iat: now })
  const input = `${header}.${payloadPart}`
  if (options.alg === 'HS256') {
    return `${input}.${createHmac('sha256', 'secret').update(input).digest('base64url')}`
  }
  return `${input}.${cryptoSign(null, Buffer.from(input), options.key ?? pair.privateKey).toString('base64url')}`
}

const request = (host: string, body: unknown, token: string | null = mint(host), extra: Record<string, string> = {}) =>
  handleTorobProductRequest(
    new Request(`http://${host}/torob/v1/products`, {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        host,
        ...(token === null ? {} : { 'x-torob-token': token, 'x-torob-token-version': '1' }),
        ...extra,
      },
      method: 'POST',
    }),
  )

const enroll = async (siteId: string, overrides: Record<string, unknown> = {}) =>
  payload.update({
    collection: 'sites',
    context: { torobEnrollmentSync: true },
    id: siteId,
    data: {
      torob: {
        authorizationState: 'authorized',
        connected: true,
        enabled: true,
        shopId: `shop-${siteId}`,
        syncedAt: new Date().toISOString(),
        ...overrides,
      },
    },
    depth: 0,
    overrideAccess: true,
  })

const makeSite = async (domain: string) => {
  const site = await payload.create({
    collection: 'sites',
    data: {
      availableLocales: ['fa'],
      defaultLocale: 'fa',
      domain,
      name: domain,
      slug: `torob-${randomUUID().slice(0, 8)}`,
      status: 'active',
      type: 'store',
    },
    depth: 0,
    overrideAccess: true,
  })
  siteIds.push(String(site.id))
  await payload.create({
    collection: 'store',
    data: { currency: 'IRT', site: site.id },
    depth: 0,
    draft: true,
    overrideAccess: true,
  })
  return site as Site
}

const makeImage = async (siteId: string, edge = 900) => {
  const bytes = await sharp({
    create: { background: { b: 40, g: 90, r: 20 }, channels: 3, height: edge, width: edge },
  })
    .png()
    .toBuffer()
  const media = await payload.create({
    collection: 'media',
    data: { alt: 'torob fixture', site: siteId },
    file: { data: bytes, mimetype: 'image/png', name: `${randomUUID()}.png`, size: bytes.length },
    overrideAccess: true,
  })
  mediaIds.push(String(media.id))
  return media
}

const makeProduct = async (siteId: string, imageId: string, data: Record<string, unknown> = {}) => {
  const title = `torob-${randomUUID().slice(0, 8)}`
  const product = await payload.create({
    collection: 'products',
    data: {
      _status: 'published',
      image: imageId,
      price: 125000,
      site: siteId,
      slug: title,
      title,
      ...data,
    },
    depth: 0,
    overrideAccess: true,
  })
  productIds.push(String(product.id))
  return product
}

let shopA: Site
let shopB: Site
let imageA: Awaited<ReturnType<typeof makeImage>>
let imageB: Awaited<ReturnType<typeof makeImage>>

beforeAll(async () => {
  process.env.TOROB_API_PUBLIC_KEY = publicKeyPem
  payload = await getPayload({ config: await config })
  shopA = await makeSite(`torob-a-${randomUUID().slice(0, 6)}.example.com`)
  shopB = await makeSite(`torob-b-${randomUUID().slice(0, 6)}.example.com`)
  imageA = await makeImage(String(shopA.id))
  imageB = await makeImage(String(shopB.id))
  await enroll(String(shopA.id))
  await enroll(String(shopB.id))
}, 180_000)

beforeEach(() => resetRateLimits())

afterAll(async () => {
  delete process.env.TOROB_API_PUBLIC_KEY
  for (const id of productIds.splice(0)) await payload.delete({ collection: 'products', id, overrideAccess: true }).catch(() => undefined)
  for (const id of mediaIds.splice(0)) await payload.delete({ collection: 'media', id, overrideAccess: true }).catch(() => undefined)
  for (const id of siteIds.splice(0)) {
    await payload.delete({ collection: 'store', overrideAccess: true, where: { site: { equals: id } } }).catch(() => undefined)
    await payload.delete({ collection: 'sites', id, overrideAccess: true }).catch(() => undefined)
  }
})

describe('tenant and auth boundary', () => {
  it('serves the enrolled shop its own published catalogue', async () => {
    const product = await makeProduct(String(shopA.id), String(imageA.id))
    const res = await request(shopA.domain, { page: 1, sort: 'date_added_desc' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.api_version).toBe('torob_api_v3')
    expect(body.products.map((p: { page_unique: string }) => p.page_unique)).toContain(String(product.id))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('denies a token minted for another shop, even when both are enrolled', async () => {
    await makeProduct(String(shopB.id), String(imageB.id))
    const res = await request(shopA.domain, { page: 1, sort: 'date_added_desc' }, mint(shopB.domain))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized: audience_mismatch' })
  })

  it('never leaks the other shop’s products or media URLs', async () => {
    const a = await makeProduct(String(shopA.id), String(imageA.id), { title: 'torob-leak-a' })
    const b = await makeProduct(String(shopB.id), String(imageB.id), { title: 'torob-leak-b' })
    const res = await request(shopA.domain, { page: 1, sort: 'date_added_desc' })
    const body = await res.json()
    const text = JSON.stringify(body)
    expect(text).toContain(String(a.id))
    expect(text).not.toContain(String(b.id))
    expect(text).not.toContain(String(imageB.id))
    expect(text).toContain(shopA.domain)
    expect(text).not.toContain(shopB.domain)
  })

  it('ignores forwarded host headers when choosing the audience', async () => {
    const res = await request(
      shopA.domain,
      { page: 1, sort: 'date_added_desc' },
      mint(shopA.domain),
      { 'x-forwarded-host': shopB.domain, 'x-original-host': shopB.domain },
    )
    expect(res.status).toBe(200)
  })

  it('404s an unknown host and a non-store host', async () => {
    expect((await request('unknown.example.com', { page: 1, sort: 'date_added_desc' })).status).toBe(404)
  })

  it.each([
    { connected: false },
    { enabled: false },
    { authorizationState: 'revoked' },
    { authorizationState: 'pending_approval' },
    { authorizationState: 'not_authorized' },
  ])('404s a site whose enrollment is %j, before reading the body', async (overrides) => {
    await enroll(String(shopA.id), overrides)
    try {
      const res = await request(shopA.domain, { page: 1, sort: 'date_added_desc' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    } finally {
      await enroll(String(shopA.id))
    }
  })

  it('rejects missing, wrong-version, expired, not-yet-valid and forged tokens', async () => {
    const body = { page: 1, sort: 'date_added_desc' }
    expect((await request(shopA.domain, body, null)).status).toBe(401)
    expect((await request(shopA.domain, body, mint(shopA.domain), { 'x-torob-token-version': '2' })).status).toBe(401)
    const now = Math.floor(Date.now() / 1000)
    expect((await request(shopA.domain, body, mint(shopA.domain, { exp: now - 10 }))).status).toBe(401)
    expect((await request(shopA.domain, body, mint(shopA.domain, { nbf: now + 60 }))).status).toBe(401)
    expect((await request(shopA.domain, body, mint(shopA.domain, { key: stranger.privateKey }))).status).toBe(401)
  })

  it('405s a non-POST verb', async () => {
    const res = await handleTorobProductRequest(new Request(`http://${shopA.domain}/torob/v1/products`, { method: 'GET' }))
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('429s a flood before the catalogue is read', async () => {
    const body = { page: 1, sort: 'date_added_desc' }
    for (let i = 0; i < 5; i += 1) {
      expect((await request(shopA.domain, body)).status).toBe(200)
    }
    const res = await request(shopA.domain, body)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'too_many_requests' })
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

describe('catalogue rules', () => {
  it('omits drafts and unpublished rows, and answers a removed product lookup with total 0', async () => {
    const published = await makeProduct(String(shopA.id), String(imageA.id))
    const draft = await makeProduct(String(shopA.id), String(imageA.id), { _status: 'draft' })
    const res = await request(shopA.domain, { page_uniques: [String(published.id), String(draft.id), 'missing'] })
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.products[0].page_unique).toBe(String(published.id))
  })

  it('marks a tracked, zero-stock product unavailable with price 0, never free', async () => {
    const product = await makeProduct(String(shopA.id), String(imageA.id), { inventory: 0, trackInventory: true })
    const res = await request(shopA.domain, { page_uniques: [String(product.id)] })
    const body = await res.json()
    expect(body.products[0]).toMatchObject({ availability: false, current_price: 0 })
    expect(body.products[0].old_price).toBeUndefined()
  })

  it('omits an available zero-price row because CMS checkout cannot sell it', async () => {
    const product = await makeProduct(String(shopA.id), String(imageA.id), { price: 0 })
    const res = await request(shopA.domain, { page_uniques: [String(product.id)] })
    expect((await res.json()).total).toBe(0)
  })

  it('publishes variable products as one page per active variation with a group id', async () => {
    const product = await makeProduct(String(shopA.id), String(imageA.id), {
      productType: 'variable',
      variations: [
        { active: true, key: 'red', label: 'قرمز', price: 200000 },
        { active: true, key: 'blue', label: 'آبی', price: 300000 },
        { active: false, key: 'hidden', label: 'پنهان', price: 100000 },
      ],
    })
    const res = await request(shopA.domain, { page_uniques: [`${product.id}~red`, `${product.id}~blue`, `${product.id}~hidden`] })
    const body = await res.json()
    expect(body.total).toBe(2)
    for (const item of body.products) {
      expect(item.product_group_id).toBe(String(product.id))
      expect(item.page_url).toContain('variant=')
      expect(item.image_links[0]).toMatch(/^https?:\/\//)
      expect(item.image_links[0]).toContain(shopA.domain)
    }
  })

  it('omits a product whose only image is too small', async () => {
    const small = await makeImage(String(shopA.id), 400)
    const tinyProduct = await makeProduct(String(shopA.id), String(small.id))
    const res = await request(shopA.domain, { page_uniques: [String(tinyProduct.id)] })
    expect((await res.json()).total).toBe(0)
  })

  it('cannot even attach another site’s media to a product', async () => {
    await expect(makeProduct(String(shopA.id), String(imageB.id))).rejects.toThrow()
  })

  it('converts IRR to whole Toman exactly and omits a non-whole price', async () => {
    await payload.update({
      collection: 'store',
      data: { currency: 'IRR' },
      depth: 0,
      overrideAccess: true,
      where: { site: { equals: String(shopA.id) } },
    })
    try {
      const whole = await makeProduct(String(shopA.id), String(imageA.id), { price: 1250000 })
      const fractional = await makeProduct(String(shopA.id), String(imageA.id), { price: 1250001 })
      const res = await request(shopA.domain, { page_uniques: [String(whole.id), String(fractional.id)] })
      const body = await res.json()
      expect(body.total).toBe(1)
      expect(body.products[0]).toMatchObject({ current_price: 125000, page_unique: String(whole.id) })
    } finally {
      await payload.update({
        collection: 'store',
        data: { currency: 'IRT' },
        depth: 0,
        overrideAccess: true,
        where: { site: { equals: String(shopA.id) } },
      })
    }
  })

  it('refuses an unsupported store currency by omitting the catalogue', async () => {
    await payload.update({
      collection: 'store',
      data: { currency: 'USD' },
      depth: 0,
      overrideAccess: true,
      where: { site: { equals: String(shopA.id) } },
    })
    try {
      await makeProduct(String(shopA.id), String(imageA.id))
      const res = await request(shopA.domain, { page: 1, sort: 'date_added_desc' })
      expect((await res.json()).total).toBe(0)
    } finally {
      await payload.update({
        collection: 'store',
        data: { currency: 'IRT' },
        depth: 0,
        overrideAccess: true,
        where: { site: { equals: String(shopA.id) } },
      })
    }
  })
})

describe('paging and lookups', () => {
  it('walks a stable cursor without duplicates and stops at the end', async () => {
    for (let i = 0; i < 3; i += 1) await makeProduct(String(shopA.id), String(imageA.id))
    const first = await (await request(shopA.domain, { cursor: null, sort: 'product_id_desc' })).json()
    expect(first.current_page).toBeUndefined()
    expect(first.products.length).toBeGreaterThan(0)
    // The fixture catalogue is smaller than 100, so the first page is also the last.
    expect(first.next_cursor).toBeNull()
    const anchor = first.products[Math.min(2, first.products.length - 1)].page_unique as string
    const cursor = encodeTorobCursor(anchor)
    const second = await (await request(shopA.domain, { cursor, sort: 'product_id_desc' })).json()
    expect(second.products.length).toBeGreaterThan(0)
    for (const item of second.products) {
      expect(item.page_unique < anchor).toBe(true)
    }
    const pastEnd = await (await request(shopA.domain, { cursor: encodeTorobCursor('\u0000'), sort: 'product_id_desc' })).json()
    expect(pastEnd.products).toEqual([])
    expect(pastEnd.next_cursor).toBeNull()
  })

  it('400s an unknown or malformed cursor', async () => {
    const res = await request(shopA.domain, { cursor: 'not-a-cursor', sort: 'product_id_desc' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'cursor must be a non-empty string' })
  })

  it('looks up by absolute URL and returns an empty envelope for a withdrawn URL', async () => {
    const product = await makeProduct(String(shopA.id), String(imageA.id))
    const page = await (await request(shopA.domain, { page_uniques: [String(product.id)] })).json()
    const url = page.products[0].page_url
    const found = await (await request(shopA.domain, { page_urls: [url] })).json()
    expect(found.total).toBe(1)
    const missing = await (await request(shopA.domain, { page_urls: [`http://${shopA.domain}/products/withdrawn`] })).json()
    expect(missing).toMatchObject({ total: 0, products: [] })
  })

  it('rejects the four malformed request shapes with Torob’s exact sentences', async () => {
    expect(await (await request(shopA.domain, {})).json()).toEqual({
      error: 'request body is empty: send page_urls, page_uniques, page, or cursor',
    })
    expect(await (await request(shopA.domain, { page: 1 })).json()).toEqual({ error: 'sort parameter is not provided' })
    expect(await (await request(shopA.domain, { page: 1, page_uniques: ['a'], sort: 'date_added_desc' })).json()).toEqual({
      error: 'request must use exactly one of page_urls, page_uniques, page, or cursor',
    })
    expect(await (await request(shopA.domain, { cursor: 'x', sort: 'date_added_desc' })).json()).toEqual({
      error: 'cursor pagination requires sort product_id_desc',
    })
  })
})
