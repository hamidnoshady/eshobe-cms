// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { migrationCenterEndpoints } from '@/endpoints/migrationCenter'
import { runMigrationJob } from '@/lib/migration/engine'
import { findForSite } from '@/lib/site-query'
import {
  createMigrationSource,
  createOrReuseMigrationJob,
} from '@/lib/migration/source'
import type { SourceClients } from '@/lib/migration/types'
import {
  createWooCommerceClient,
  createWordPressClient,
  type FetchImpl,
} from '@/lib/wordpress/client'
import {
  wpPortfolioEntry,
  wpTaxonomiesResponse,
  wpTypesResponse,
} from '@/lib/wordpress/fixtures'

import { cmsTypedUser } from './cmsUser'

/**
 * Issue #166 — the whole migration engine against a fixture WordPress.
 *
 * No live network exists in the sandbox/CI, so the WP/Woo REST surface is a
 * fetch fake over mutable fixture rows. That still exercises the production
 * clients (pagination, auth shape, headers), discovery, the dry-run's
 * no-destination-write guarantee, import idempotency, delta sync,
 * reconciliation, fenced cutover, redirects and the rollback conflict rule.
 */

type Raw = Record<string, unknown>

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1_000_000).toString(36)}`
const BASE = `https://migration-${suffix}.example.ir`
const WP_SECRET = 'migration-wp-secret-for-test'
const WOO_SECRET = 'migration-woo-secret-for-test'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
)

let payload: Payload
let shopId = ''
let acmeId = ''
let sourceId = ''
let installation = ''
let jobId = ''
let clients: SourceClients
let downloadCount = 0

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const fixture = {
  categories: [
    {
      count: 1,
      description: 'اخبار فروشگاه',
      id: 5,
      link: `${BASE}/category/news-${suffix}/`,
      name: 'اخبار',
      parent: 0,
      slug: `news-${suffix}`,
      taxonomy: 'category',
    },
  ] as Raw[],
  coupons: [
    {
      amount: '10',
      code: `save-${suffix}`,
      date_modified_gmt: '2024-01-02T00:00:00',
      description: 'ده درصد',
      discount_type: 'percent',
      id: 61,
      status: 'publish',
      usage_count: 1,
    },
  ] as Raw[],
  customers: [
    {
      billing: {
        address_1: 'خیابان نمونه ۱',
        city: 'تهران',
        country: 'IR',
        email: `buyer-${suffix}@example.ir`,
        first_name: 'سارا',
        last_name: 'مشتری',
        phone: '09120000000',
        postcode: '1234567890',
      },
      date_modified_gmt: '2024-01-02T00:00:00',
      email: `buyer-${suffix}@example.ir`,
      first_name: 'سارا',
      id: 15,
      last_name: 'مشتری',
      name: 'سارا مشتری',
      shipping: {
        address_1: 'خیابان نمونه ۲',
        city: 'تهران',
        country: 'IR',
        first_name: 'سارا',
        last_name: 'مشتری',
        phone: '09120000000',
        postcode: '1234567890',
      },
      username: `buyer-${suffix}`,
    },
  ] as Raw[],
  genre: [
    {
      count: 2,
      description: '',
      id: 11,
      link: `${BASE}/genre/residential-${suffix}/`,
      name: 'مسکونی',
      parent: 0,
      slug: `residential-${suffix}`,
      taxonomy: 'genre',
    },
    {
      count: 1,
      description: '',
      id: 12,
      link: `${BASE}/genre/villa-${suffix}/`,
      name: 'ویلایی',
      parent: 11,
      slug: `villa-${suffix}`,
      taxonomy: 'genre',
    },
  ] as Raw[],
  media: [
    {
      alt_text: 'تصویر اصلی',
      caption: { rendered: '<p>شرح تصویر</p>' },
      date_gmt: '2024-01-01T00:00:00',
      id: 501,
      link: `${BASE}/hero-${suffix}/`,
      mime_type: 'image/png',
      modified_gmt: '2024-01-01T00:00:00',
      slug: `hero-${suffix}`,
      source_url: `${BASE}/wp-content/uploads/hero-${suffix}.png`,
      title: { rendered: 'تصویر اصلی' },
    },
    {
      alt_text: 'تصویر دوم',
      caption: { rendered: '' },
      date_gmt: '2024-01-01T00:00:00',
      id: 502,
      link: `${BASE}/second-${suffix}/`,
      mime_type: 'image/png',
      modified_gmt: '2024-01-01T00:00:00',
      slug: `second-${suffix}`,
      source_url: `${BASE}/wp-content/uploads/second-${suffix}.png`,
      title: { rendered: 'تصویر دوم' },
    },
  ] as Raw[],
  orders: [] as Raw[],
  pages: [
    {
      author: 7,
      content: { rendered: '<p>درباره فروشگاه</p>' },
      date: '2024-02-01T10:00:00',
      date_gmt: '2024-02-01T06:30:00',
      excerpt: { rendered: '' },
      featured_media: 0,
      id: 40,
      link: `${BASE}/about-${suffix}/`,
      modified_gmt: '2024-02-01T06:30:00',
      parent: 0,
      slug: `about-${suffix}`,
      status: 'publish',
      title: { rendered: 'درباره ما' },
      type: 'page',
    },
    {
      author: 7,
      content: { rendered: '<p>تیم فروشگاه</p>' },
      date: '2024-02-02T10:00:00',
      date_gmt: '2024-02-02T06:30:00',
      excerpt: { rendered: '' },
      featured_media: 0,
      id: 42,
      link: `${BASE}/about-${suffix}/team-${suffix}/`,
      modified_gmt: '2024-02-02T06:30:00',
      parent: 40,
      slug: `team-${suffix}`,
      status: 'publish',
      title: { rendered: 'تیم ما' },
      type: 'page',
    },
  ] as Raw[],
  portfolio: [] as Raw[],
  posts: [
    {
      author: 7,
      categories: [5],
      content: { raw: '<p>سلام <strong>دنیا</strong></p>', rendered: '<p>سلام <strong>دنیا</strong></p>' },
      date: '2024-02-03T10:00:00',
      date_gmt: '2024-02-03T06:30:00',
      excerpt: { rendered: '<p>خلاصه نوشته</p>' },
      featured_media: 501,
      id: 41,
      link: `${BASE}/hello-${suffix}/`,
      modified_gmt: '2024-02-03T06:30:00',
      slug: `hello-${suffix}`,
      status: 'publish',
      tags: [21],
      title: { rendered: 'سلام دنیا' },
      type: 'post',
    },
  ] as Raw[],
  productCat: [
    {
      count: 3,
      description: '',
      id: 71,
      link: `${BASE}/product-category/books-${suffix}/`,
      name: 'کتاب‌ها',
      parent: 0,
      slug: `books-${suffix}`,
      taxonomy: 'product_cat',
    },
  ] as Raw[],
  products: [] as Raw[],
  refunds: [
    {
      amount: '10000',
      date_created: '2024-03-02T08:30:00',
      date_created_gmt: '2024-03-02T05:00:00',
      id: 81,
      reason: 'بازگشت یک قلم',
      total: '-10000',
    },
  ] as Raw[],
  tags: [
    {
      count: 2,
      description: '',
      id: 21,
      link: `${BASE}/tag/featured-${suffix}/`,
      name: 'ویژه',
      parent: 0,
      slug: `featured-${suffix}`,
      taxonomy: 'post_tag',
    },
  ] as Raw[],
  variations: [
    {
      attributes: [{ name: 'رنگ', option: 'قرمز', slug: 'pa_color' }],
      date_modified_gmt: '2024-01-02T00:00:00',
      id: 100,
      manage_stock: true,
      price: '300000',
      regular_price: '300000',
      sku: `TS-${suffix}-RED`,
      status: 'publish',
      stock_quantity: 7,
    },
    {
      attributes: [{ name: 'رنگ', option: 'آبی', slug: 'pa_color' }],
      date_modified_gmt: '2024-01-02T00:00:00',
      id: 101,
      manage_stock: true,
      price: '320000',
      regular_price: '340000',
      sku: `TS-${suffix}-BLUE`,
      status: 'publish',
      stock_quantity: 3,
    },
  ] as Raw[],
}

fixture.portfolio = [
  {
    ...clone(wpPortfolioEntry()),
    genre: [12],
    id: 44,
    link: `${BASE}/نمونه‌کار/sea-house-${suffix}/`,
    slug: `sea-house-${suffix}`,
    tags: [21],
  },
]
fixture.products = [
  {
    attributes: [],
    categories: [{ id: 71 }],
    date_modified_gmt: '2024-01-02T00:00:00',
    description: '<p>کتاب نخست</p>',
    downloadable: false,
    id: 31,
    images: [{ id: 501, src: `${BASE}/wp-content/uploads/hero-${suffix}.png` }],
    manage_stock: true,
    name: 'کتاب الف',
    permalink: `${BASE}/product/book-a-${suffix}/`,
    price: '200000',
    regular_price: '200000',
    short_description: '<p>خلاصه کتاب الف</p>',
    sku: `BOOK-A-${suffix}`,
    slug: `book-a-${suffix}`,
    status: 'publish',
    stock_quantity: 9,
    tags: [],
    type: 'simple',
    virtual: false,
  },
  {
    attributes: [],
    categories: [{ id: 71 }],
    date_modified_gmt: '2024-01-02T00:00:00',
    description: '<p>کتاب دوم</p>',
    downloadable: false,
    id: 32,
    images: [],
    manage_stock: false,
    name: 'کتاب ب',
    permalink: `${BASE}/product/book-b-${suffix}/`,
    price: '250000',
    regular_price: '250000',
    short_description: '<p>خلاصه کتاب ب</p>',
    sku: `BOOK-B-${suffix}`,
    slug: `book-b-${suffix}`,
    status: 'publish',
    stock_quantity: null,
    tags: [],
    type: 'simple',
    virtual: false,
  },
  {
    attributes: [
      {
        id: 1,
        name: 'رنگ',
        options: ['قرمز', 'آبی'],
        slug: 'pa_color',
        variation: true,
        visible: true,
      },
    ],
    categories: [{ id: 71 }],
    date_modified_gmt: '2024-01-02T00:00:00',
    description: '<p>تیشرت نخی</p>',
    downloadable: false,
    id: 99,
    images: [
      { id: 501, src: `${BASE}/wp-content/uploads/hero-${suffix}.png` },
      { id: 502, src: `${BASE}/wp-content/uploads/second-${suffix}.png` },
    ],
    manage_stock: false,
    name: 'تیشرت نخی',
    permalink: `${BASE}/product/tshirt-${suffix}/`,
    price: '',
    regular_price: '',
    short_description: '<p>خلاصه تیشرت</p>',
    sku: `TS-${suffix}`,
    slug: `tshirt-${suffix}`,
    status: 'publish',
    stock_quantity: null,
    tags: [],
    type: 'variable',
    variations: [100, 101],
    virtual: false,
  },
]
fixture.orders = [
  {
    billing: {
      address_1: 'خیابان نمونه ۱',
      city: 'تهران',
      country: 'IR',
      email: `buyer-${suffix}@example.ir`,
      first_name: 'سارا',
      last_name: 'مشتری',
      phone: '09120000000',
      postcode: '1234567890',
    },
    coupon_lines: [{ code: `save-${suffix}`, discount: '70000', id: 61 }],
    currency: 'IRT',
    customer_id: 15,
    customer_note: 'لطفاً تماس بگیرید',
    date_created_gmt: '2024-03-01T08:30:00',
    date_modified_gmt: '2024-03-01T08:30:00',
    date_paid_gmt: '2024-03-01T08:35:00',
    discount_total: '70000',
    fee_lines: [],
    id: 700,
    line_items: [
      {
        id: 1,
        name: 'کتاب الف',
        price: '200000',
        product_id: 31,
        quantity: 2,
        sku: `BOOK-A-${suffix}`,
        subtotal: '400000',
        taxes: [],
        total: '360000',
        variation_id: 0,
      },
      {
        id: 2,
        meta_data: [{ key: 'pa_color', value: 'قرمز' }],
        name: 'تیشرت نخی',
        price: '300000',
        product_id: 99,
        quantity: 1,
        sku: `TS-${suffix}-RED`,
        subtotal: '300000',
        taxes: [],
        total: '270000',
        variation_id: 100,
      },
    ],
    number: '700',
    payment_method: 'bank',
    payment_method_title: 'پرداخت بانکی',
    refunds: [{ id: 81, total: '-10000' }],
    shipping: {
      address_1: 'خیابان نمونه ۲',
      city: 'تهران',
      country: 'IR',
      first_name: 'سارا',
      last_name: 'مشتری',
      phone: '09120000000',
      postcode: '1234567890',
    },
    shipping_lines: [
      { method_id: 'flat_rate', method_title: 'پست', total: '60000', total_tax: '0' },
    ],
    shipping_total: '60000',
    status: 'completed',
    tax_lines: [],
    total: '690000',
    total_tax: '0',
    transaction_id: `TX-${suffix}`,
  },
]

const modifiedOf = (item: Raw): string =>
  String(item.modified_gmt ?? item.date_modified_gmt ?? item.date_gmt ?? item.date_created_gmt ?? '')

const listFor = (path: string): Raw[] | null => {
  if (path === '/wp-json/wp/v2/categories') return fixture.categories
  if (path === '/wp-json/wp/v2/tags') return fixture.tags
  if (path === '/wp-json/wp/v2/genre') return fixture.genre
  if (path === '/wp-json/wp/v2/product_cat') return fixture.productCat
  if (path === '/wp-json/wp/v2/product_tag') return []
  if (path === '/wp-json/wp/v2/media') return fixture.media
  if (path === '/wp-json/wp/v2/posts') return fixture.posts
  if (path === '/wp-json/wp/v2/pages') return fixture.pages
  if (path === '/wp-json/wp/v2/portfolio') return fixture.portfolio
  if (path === '/wp-json/wp/v2/plugins') return []
  if (path === '/wp-json/wc/v3/products') return fixture.products
  if (path === '/wp-json/wc/v3/customers') return fixture.customers
  if (path === '/wp-json/wc/v3/coupons') return fixture.coupons
  if (path === '/wp-json/wc/v3/orders') return fixture.orders
  if (/^\/wp-json\/wc\/v3\/products\/99\/variations$/.test(path)) return fixture.variations
  if (/^\/wp-json\/wc\/v3\/orders\/700\/refunds$/.test(path)) return fixture.refunds
  if (path === '/wp-json/wc/v3/settings/general') {
    return [
      { id: 'woocommerce_currency', value: 'IRT' },
      { id: 'woocommerce_price_num_decimals', value: '0' },
    ]
  }
  return null
}

const objectFor = (path: string): Raw | null => {
  if (path === '/wp-json/') return { name: 'فروشگاه نمونه', namespaces: ['wp/v2', 'wc/v3'] }
  if (path === '/wp-json/wp/v2/types') return clone(wpTypesResponse())
  if (path === '/wp-json/wp/v2/taxonomies') {
    return {
      ...clone(wpTaxonomiesResponse()),
      product_tag: {
        hierarchical: false,
        name: 'برچسب محصول',
        rest_base: 'product_tag',
        slug: 'product_tag',
        types: ['product'],
      },
    }
  }
  if (path === '/wp-json/wc/v3/data/currencies/current') return { code: 'IRT', symbol: 'تومان' }
  if (path === '/wp-json/wc/v3/system_status') return { active_plugins: [] }
  return null
}

const fetchImpl: FetchImpl = async (url) => {
  const parsed = new URL(url)
  const path = parsed.pathname
  const object = objectFor(path)
  const list = object ? null : listFor(path)
  let body: unknown = object

  if (list) {
    const modifiedAfter = parsed.searchParams.get('modified_after')
    const filtered = modifiedAfter
      ? list.filter((item) => modifiedOf(item) > modifiedAfter.replace(/Z$/, ''))
      : list
    const perPage = Number(parsed.searchParams.get('per_page') ?? 100)
    const page = Number(parsed.searchParams.get('page') ?? 1)
    const totalPages = Math.max(1, Math.ceil(filtered.length / perPage))
    body = clone(filtered.slice((page - 1) * perPage, page * perPage))

    return {
      headers: {
        get: (name: string) => (name.toLowerCase() === 'x-wp-totalpages' ? String(totalPages) : null),
      },
      json: async () => body,
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }
  }

  if (object) {
    return {
      headers: { get: () => null },
      json: async () => clone(object),
      ok: true,
      status: 200,
      text: async () => JSON.stringify(object),
    }
  }

  return {
    headers: { get: () => null },
    json: async () => ({ code: 'rest_no_route', message: `no fixture for ${path}` }),
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ code: 'rest_no_route', message: `no fixture for ${path}` }),
  }
}

const userByEmail = async (email: string) => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: email } },
  })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  if (email !== 'admin@eshobe.test') expect(docs[0].role).not.toBe('platformAdmin')
  return docs[0]
}

const reqAs = async (email: string, extra: Partial<PayloadRequest> = {}): Promise<PayloadRequest> =>
  createLocalReq({ req: extra, user: cmsTypedUser(await userByEmail(email)) }, payload)

const endpoint = (method: string, path: string) => {
  const found = migrationCenterEndpoints.find((item) => item.method === method && item.path === path)
  if (!found?.handler) throw new Error(`Missing migration endpoint ${method} ${path}`)
  return found.handler
}

const postReq = (body: unknown, routeParams?: Record<string, string>): Partial<PayloadRequest> =>
  ({
    json: async () => body,
    ...(routeParams ? { routeParams } : {}),
    url: 'http://localhost/api/site/migration',
  }) as Partial<PayloadRequest>

const findSite = async (slug: string): Promise<string> => {
  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    where: { slug: { equals: slug } },
  })
  if (!docs[0]) throw new Error(`Site ${slug} missing — run \`pnpm seed\``)
  return String(docs[0].id)
}

const asNever = (value: unknown): never => value as never

const operation = async (nextOperation: string) => {
  await payload.update({
    id: jobId,
    collection: 'migration-jobs',
    data: { control: 'run', operation: nextOperation, status: 'queued' } as never,
    depth: 0,
    overrideAccess: true,
  })
  const req = await reqAs('shop@eshobe.test')
  const result = await runMigrationJob(req, {
    jobId,
    options: {
      clients,
      download: async (url: string) => {
        downloadCount += 1
        return {
          data: PNG,
          mimetype: 'image/png',
          name: decodeURIComponent(url.split('/').pop() ?? `media-${suffix}.png`),
        }
      },
      perPage: 2,
    },
    siteId: shopId,
  })
  if (!result) throw new Error(`Migration job ${jobId} did not run`)
  if (result.status === 'failed') {
    const { docs } = await payload.find({
      collection: 'migration-errors',
      depth: 0,
      limit: 20,
      overrideAccess: true,
      sort: '-updatedAt',
      where: { job: { equals: jobId } },
    })
    const details = docs
      .map((doc) => `${String(doc.code)} ${String(doc.resource ?? '')}: ${String(doc.message)}`)
      .join('\n')
    throw new Error(`Migration ${nextOperation} failed: ${String(result.lastError ?? '')}\n${details}`)
  }
  return result
}

const expectStatus = async (result: { status: string }, status: string): Promise<void> => {
  if (result.status === status) return
  const [{ docs: errors }, rows] = await Promise.all([
    payload.find({
      collection: 'migration-errors',
      depth: 0,
      limit: 30,
      overrideAccess: true,
      sort: '-updatedAt',
      where: { job: { equals: jobId } },
    }),
    ledger(),
  ])
  const badRows = rows
    .filter((row) => ['blocked', 'error'].includes(String(row.disposition)))
    .map((row) => `${String(row.resource)}:${String(row.sourceRecordId)}=${String(row.disposition)} ${String(row.lastError ?? '')}`)
  const badErrors = errors.map(
    (doc) => `${String(doc.code)} ${String(doc.resource ?? '')}:${String(doc.sourceRecordId ?? '')} ${String(doc.message)}`,
  )
  const report = (result as Raw).reconciliationReport as Raw | undefined
  const reportDetails = report
    ? [
        `reconciliation counts=${JSON.stringify(report.counts)} totals=${JSON.stringify(report.totals)}`,
        `reconciliation issueCounts=${JSON.stringify(report.issueCounts)}`,
        ...((report.issues as Raw[]) ?? []).map(
          (issue) =>
            `issue ${String(issue.code)} ${String(issue.resource ?? '')}:${String(issue.sourceRecordId ?? '')} ${String(issue.message)}`,
        ),
      ]
    : []
  throw new Error(
    `Expected migration status ${status}, got ${result.status}\n${[
      ...reportDetails,
      ...badErrors,
      ...badRows,
    ].join('\n')}`,
  )
}

const destination = async (
  collection: string,
  sourceRecordId: number | string,
): Promise<Raw | null> => {
  const { docs } = await payload.find({
    collection: asNever(collection),
    depth: 0,
    limit: 2,
    locale: 'fa' as never,
    overrideAccess: true,
    where: asNever({
      and: [
        { site: { equals: shopId } },
        { 'source.installation': { equals: installation } },
        { 'source.sourceId': { equals: String(sourceRecordId) } },
      ],
    }),
  })

  return (docs[0] as Raw | undefined) ?? null
}

const ledger = async (): Promise<Raw[]> => {
  const { docs } = await payload.find({
    collection: 'migration-records',
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    where: { source: { equals: sourceId } },
  })

  return docs as unknown as Raw[]
}

const id = (value: unknown): string =>
  value && typeof value === 'object' ? String((value as Raw).id ?? '') : String(value ?? '')

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  shopId = await findSite('shop')
  acmeId = await findSite('acme')

  clients = {
    woo: createWooCommerceClient({
      baseUrl: BASE,
      consumerKey: 'ck_test',
      consumerSecret: WOO_SECRET,
      fetchImpl,
      perPage: 2,
      sleep: async () => undefined,
    }),
    wp: createWordPressClient({
      applicationPassword: WP_SECRET,
      baseUrl: BASE,
      fetchImpl,
      perPage: 2,
      sleep: async () => undefined,
      username: 'admin',
    }),
  }

  const ownerReq = await reqAs('shop@eshobe.test')
  const created = await createMigrationSource(
    ownerReq,
    shopId,
    {
      baseUrl: BASE,
      name: `مهاجرت آزمایشی ${suffix}`,
      wooConsumerKey: 'ck_test',
      wooConsumerSecret: WOO_SECRET,
      wpApplicationPassword: WP_SECRET,
      wpUsername: 'admin',
    },
    { lookup: async () => [{ address: '93.184.216.34' }] },
  )
  if (!created.source) throw new Error(created.message ?? 'source creation failed')
  sourceId = String(created.source.id)
  installation = String(created.source.installation)

  const job = await createOrReuseMigrationJob(ownerReq, shopId, sourceId, {
    settings: {
      applyRedirects: true,
      includeContent: true,
      includeCoupons: true,
      includeCustomers: true,
      includeMedia: true,
      includeOrders: true,
      includeProducts: true,
      locale: 'fa',
      sourceCurrency: 'IRT',
      sourceDecimals: 0,
      targetCurrency: 'IRT',
    },
    title: `مهاجرت آزمایشی ${suffix}`,
  })
  if (!job) throw new Error('job creation failed')
  jobId = String(job.id)
}, 180_000)

afterAll(async () => {
  const records = await ledger().catch(() => [])
  const order = [
    'orders',
    'entry-term-relations',
    'content-relations',
    'coupons',
    'customers',
    'products',
    'content-entries',
    'posts',
    'pages',
    'taxonomy-terms',
    'categories',
    'media',
    'content-type-definitions',
    'taxonomy-definitions',
  ]
  records.sort(
    (a, b) =>
      order.indexOf(String(a.destinationCollection)) -
      order.indexOf(String(b.destinationCollection)),
  )
  for (const record of records) {
    if (!record.destinationCollection || !record.destinationId) continue
    await payload
      .delete({
        id: String(record.destinationId),
        collection: asNever(record.destinationCollection),
        depth: 0,
        overrideAccess: true,
      })
      .catch(() => undefined)
  }

  const migrationRedirects = await payload
    .find({
      collection: 'migration-redirects',
      depth: 0,
      limit: 0,
      overrideAccess: true,
      pagination: false,
      where: { source: { equals: sourceId } },
    })
    .catch(() => ({ docs: [] as Raw[] }))
  for (const row of migrationRedirects.docs as unknown as Raw[]) {
    const redirectId = id(row.redirect)
    if (redirectId) {
      await payload
        .delete({ id: redirectId, collection: 'redirects', depth: 0, overrideAccess: true })
        .catch(() => undefined)
    }
  }

  for (const collection of [
    'migration-redirects',
    'migration-records',
    'migration-mappings',
    'migration-batches',
    'migration-errors',
    'migration-events',
    'migration-audits',
  ]) {
    await payload
      .delete({
        collection: asNever(collection),
        overrideAccess: true,
        where: asNever({ source: { equals: sourceId } }),
      })
      .catch(() => undefined)
  }
  await payload
    .delete({
      collection: 'migration-jobs',
      overrideAccess: true,
      where: { source: { equals: sourceId } },
    })
    .catch(() => undefined)
  await payload
    .delete({ id: sourceId, collection: 'migration-sources', depth: 0, overrideAccess: true })
    .catch(() => undefined)
}, 180_000)

describe('Migration Center endpoints', () => {
  it('are owner-scoped, hide secrets, and let an editor read but not manage', async () => {
    const getHandler = endpoint('get', '/site/migration')
    const ownerRes = await getHandler(
      await reqAs('shop@eshobe.test', {
        url: `http://localhost/api/site/migration?site=${shopId}`,
      } as Partial<PayloadRequest>),
    )
    expect(ownerRes.status).toBe(200)
    const raw = await ownerRes.text()
    expect(raw).not.toContain(WP_SECRET)
    expect(raw).not.toContain(WOO_SECRET)
    expect(raw).not.toContain('enc:v1:')
    const body = JSON.parse(raw) as { canManage: boolean; sources: Raw[] }
    expect(body.canManage).toBe(true)
    expect(body.sources.some((source) => source.id === sourceId)).toBe(true)

    const crossSite = await getHandler(
      await reqAs('acme@eshobe.test', {
        url: `http://localhost/api/site/migration?site=${shopId}`,
      } as Partial<PayloadRequest>),
    )
    expect(crossSite.status).toBe(403)

    const editorRead = await getHandler(
      await reqAs('shop-editor@eshobe.test', {
        url: `http://localhost/api/site/migration?site=${shopId}`,
      } as Partial<PayloadRequest>),
    )
    expect(editorRead.status).toBe(200)
    const editorWrite = await endpoint('post', '/site/migration/job/:id/settings')(
      await reqAs(
        'shop-editor@eshobe.test',
        postReq({ settings: { includeMedia: false }, site: shopId }, { id: jobId }),
      ),
    )
    expect(editorWrite.status).toBe(403)
    expect(acmeId).not.toBe(shopId)
  }, 180_000)

  it('queues through the owner endpoint after saving settings', async () => {
    const settingsRes = await endpoint('post', '/site/migration/job/:id/settings')(
      await reqAs(
        'shop@eshobe.test',
        postReq(
          {
            settings: { sourceCurrency: 'IRT', sourceDecimals: 0, targetCurrency: 'IRT' },
            site: shopId,
          },
          { id: jobId },
        ),
      ),
    )
    expect(settingsRes.status).toBe(200)

    const queueRes = await endpoint('post', '/site/migration/job/:id/queue')(
      await reqAs(
        'shop@eshobe.test',
        postReq({ operation: 'discover', site: shopId }, { id: jobId }),
      ),
    )
    expect(queueRes.status).toBe(200)
    const body = (await queueRes.json()) as { job: Raw }
    expect(body.job.status).toBe('queued')
  }, 180_000)
})

describe('migration engine', () => {
  it('discovers coverage and dry-runs without writing destinations', async () => {
    const discovered = await operation('discover')
    expect(discovered.status).toBe('ready')
    const coverage = discovered.coverage as Raw[]
    expect(coverage.find((row) => row.resource === 'orders')?.disposition).toBe('requires-mapping')
    expect(coverage.find((row) => row.resource === 'post-type:portfolio')?.disposition).toBe(
      'supported',
    )

    const dry = await operation('dry-run')
    expect(dry.status).toBe('ready')
    const report = dry.dryRunReport as Raw
    expect(report.readyToImport).toBe(true)
    expect(await destination('posts', 41)).toBeNull()
    expect(await destination('products', 99)).toBeNull()
    expect(await destination('orders', 700)).toBeNull()

    const rows = await ledger()
    expect(rows.length).toBeGreaterThan(15)
    expect(rows.some((row) => row.resource === 'orders' && row.disposition === 'planned')).toBe(true)
    expect(rows.every((row) => row.destinationId === null || row.destinationId === undefined)).toBe(
      true,
    )
    expect(downloadCount).toBe(0)
  }, 180_000)

  it('imports content, media, commerce, history and redirects once', async () => {
    const paused = await endpoint('post', '/site/migration/job/:id/control')(
      await reqAs(
        'shop@eshobe.test',
        postReq({ control: 'pause', site: shopId }, { id: jobId }),
      ),
    )
    expect(paused.status).toBe(200)
    const resumed = await endpoint('post', '/site/migration/job/:id/control')(
      await reqAs('shop@eshobe.test', postReq({ control: 'run', site: shopId }, { id: jobId })),
    )
    expect(resumed.status).toBe(200)

    const imported = await operation('import')
    await expectStatus(imported, 'ready')
    expect(imported.counts?.errors).toBe(0)
    expect(imported.counts?.blocked).toBe(0)

    const [post, parentPage, childPage, entry, simple, variable, customer, coupon, order] =
      await Promise.all([
        destination('posts', 41),
        destination('pages', 40),
        destination('pages', 42),
        destination('content-entries', 44),
        destination('products', 31),
        destination('products', 99),
        destination('customers', 15),
        destination('coupons', 61),
        destination('orders', 700),
      ])
    expect(post?.title).toBe('سلام دنیا')
    expect(id(childPage?.parent)).toBe(String(parentPage?.id))
    expect(entry?.title).toBe('خانهٔ کنار دریا')
    expect((entry?.fieldValues as Raw)?.client).toBe('شرکت آوا')

    expect(simple?.inventory).toBe(9)
    expect(simple?.trackInventory).toBe(true)
    const variations = variable?.variations as Raw[]
    expect(variations).toHaveLength(2)
    expect(variations.map((row) => row.inventory).sort()).toEqual([3, 7])
    expect(customer?.email).toBe(`buyer-${suffix}@example.ir`)
    expect(coupon?.code).toBe(`SAVE-${suffix}`.toUpperCase())
    expect(order?.reference).toBe('WOO-700')
    expect((order?.items as Raw[]).length).toBe(2)
    expect(order?.total).toBe(690_000)
    expect(id(order?.customer)).toBe(String(customer?.id))
    expect((order?.refunds as Raw[])?.[0]?.amount).toBe(10_000)

    const { docs: redirects } = await payload.find({
      collection: 'redirects',
      depth: 0,
      limit: 5,
      overrideAccess: true,
      where: {
        and: [{ site: { equals: shopId } }, { from: { equals: `/hello-${suffix}` } }],
      },
    })
    expect(redirects).toHaveLength(1)
    expect((redirects[0]?.to as Raw)?.url).toBe(`/posts/hello-${suffix}`)

    // The public renderer must resolve that staff-only-over-HTTP collection
    // without a user, but only through findForSite's exact tenant clause.
    const publicRules = await findForSite('redirects', shopId, {
      depth: 0,
      limit: 1,
      locale: 'fa',
      pagination: false,
      select: { from: true, to: { type: true, url: true } },
      where: { from: { equals: `/hello-${suffix}` } },
    })
    expect(publicRules.docs).toHaveLength(1)
    expect(publicRules.docs[0]?.to?.url).toBe(`/posts/hello-${suffix}`)
    const otherTenantRules = await findForSite('redirects', acmeId, {
      depth: 0,
      limit: 1,
      locale: 'fa',
      pagination: false,
      where: { from: { equals: `/hello-${suffix}` } },
    })
    expect(otherTenantRules.docs).toEqual([])
    expect(downloadCount).toBe(2)

    const rows = await ledger()
    const keys = rows.map((row) => row.idempotencyKey)
    expect(new Set(keys).size).toBe(keys.length)
  }, 180_000)

  it('is idempotent on a full re-run', async () => {
    const before = {
      customers: await payload.count({ collection: 'customers', where: { site: { equals: shopId } } }),
      orders: await payload.count({ collection: 'orders', where: { site: { equals: shopId } } }),
      posts: await payload.count({ collection: 'posts', where: { site: { equals: shopId } } }),
      products: await payload.count({ collection: 'products', where: { site: { equals: shopId } } }),
    }
    const rerun = await operation('import')
    await expectStatus(rerun, 'ready')
    expect(rerun.counts?.imported).toBe(0)
    expect(rerun.counts?.errors).toBe(0)
    expect(downloadCount).toBe(2)

    const after = {
      customers: await payload.count({ collection: 'customers', where: { site: { equals: shopId } } }),
      orders: await payload.count({ collection: 'orders', where: { site: { equals: shopId } } }),
      posts: await payload.count({ collection: 'posts', where: { site: { equals: shopId } } }),
      products: await payload.count({ collection: 'products', where: { site: { equals: shopId } } }),
    }
    expect(after).toEqual(before)
  }, 180_000)

  it('refuses to roll back a manually edited document, then can re-import', async () => {
    const post = await destination('posts', 41)
    if (!post) throw new Error('imported post missing before rollback')
    await payload.update({
      id: String(post.id),
      collection: 'posts',
      data: { title: 'عنوان دست‌خورده' } as never,
      depth: 0,
      locale: 'fa' as never,
      overrideAccess: true,
    })
    const rollback = await operation('rollback')
    expect(rollback.status).toBe('blocked')
    expect(await destination('posts', 41)).not.toBeNull()
    expect(await destination('orders', 700)).toBeNull()
    expect(await destination('products', 99)).toBeNull()

    const reimported = await operation('import')
    await expectStatus(reimported, 'ready')
    const restored = await destination('posts', 41)
    expect(restored?.title).toBe('سلام دنیا')
    expect(await destination('orders', 700)).not.toBeNull()
  }, 180_000)

  it('delta-syncs a changed source record and reconciles cleanly', async () => {
    const changed = fixture.posts[0]!
    changed.title = { rendered: 'سلام دنیای تازه' }
    changed.modified_gmt = new Date(Date.now() + 1_000).toISOString().slice(0, 19)

    const synced = await operation('sync')
    await expectStatus(synced, 'ready')
    expect((await destination('posts', 41))?.title).toBe('سلام دنیای تازه')

    const reconciled = await operation('reconcile')
    await expectStatus(reconciled, 'ready-for-cutover')
    const report = reconciled.reconciliationReport as Raw
    expect(report.ok).toBe(true)
    expect((report.totals as Raw).sourceOrderTotal).toBe(
      (report.totals as Raw).destinationOrderTotal,
    )
  }, 180_000)

  it('requires the write fence, then completes cutover', async () => {
    const refused = await operation('cutover')
    expect(refused.status).toBe('blocked')
    expect(String(refused.lastError ?? '')).toContain('توقف نوشتن')

    const fence = await endpoint('post', '/site/migration/job/:id/write-fence')(
      await reqAs(
        'shop@eshobe.test',
        postReq({ confirmed: true, site: shopId }, { id: jobId }),
      ),
    )
    expect(fence.status).toBe(200)

    const cutover = await operation('cutover')
    await expectStatus(cutover, 'completed')
    expect(cutover.cutoverAt).toBeTruthy()
  }, 180_000)
})
