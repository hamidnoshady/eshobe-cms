import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { siteDescriptor } from '@/endpoints/siteDescriptor'
import { idOf } from '@/lib/ids'

/**
 * The headless contract — Wave 9.
 *
 * What a *separate* frontend may see when it attaches to this CMS over the public
 * API. These are the tests the "never call `payload.find` in front-end code" rule was
 * never able to cover: that rule protects this app's own rendering, and an external
 * renderer does not route through it. The guarantee has to live in the collections'
 * access control (`src/access/siteRead.ts`), which is what this file exercises.
 *
 * Reads are issued through `createLocalReq` with a real `Host` header, which is the
 * only thing that establishes a tenant on a public request.
 */
let payload: Payload

const acmeId = { value: '' }
const studioId = { value: '' }

const read = <T = Record<string, unknown>>({
  collection,
  host,
  where,
}: {
  collection: string
  host: string
  where?: Record<string, unknown>
}): Promise<T[]> =>
  createLocalReq(
    {
      req: {
        headers: new Headers({ accept: 'application/json', host }),
        method: 'GET',
        url: `http://${host}/api/${collection}`,
      } as Partial<PayloadRequest>,
    },
    payload,
  ).then((req) =>
    (payload.find as (args: unknown) => Promise<{ docs: T[] }>)({
      collection,
      depth: 0,
      overrideAccess: false,
      pagination: false,
      req,
      where,
    }).then(({ docs }) => docs),
  )

beforeAll(async () => {
  payload = await getPayload({ config: await config })

  const { docs } = await payload.find({ collection: 'sites', depth: 0, pagination: false })

  for (const site of docs as { domain: string; id: string }[]) {
    if (site.domain === 'acme.localhost') acmeId.value = site.id
    if (site.domain === 'studio.localhost') studioId.value = site.id
  }
}, 180_000)

describe('public reads on a customer host', () => {
  it('see only that host’s pages', async () => {
    const onAcme = await read({ collection: 'pages', host: 'acme.localhost' })
    const onStudio = await read({ collection: 'pages', host: 'studio.localhost' })

    expect(onAcme.length).toBeGreaterThan(0)
    expect(onStudio.length).toBeGreaterThan(0)
    expect(new Set(onAcme.map((doc) => idOf(doc.site)))).toEqual(new Set([acmeId.value]))
    expect(new Set(onStudio.map((doc) => idOf(doc.site)))).toEqual(new Set([studioId.value]))
  })

  it('cannot be redirected to another tenant by the caller’s own filter', async () => {
    // The shape a client would send to switch tenants: `?where[site][equals]=<other>`.
    // It is ANDed with the host's scope, so it now narrows to the empty set instead of
    // selecting a different customer.
    const stolen = await read({
      collection: 'pages',
      host: 'acme.localhost',
      where: { site: { equals: studioId.value } },
    })

    expect(stolen).toHaveLength(0)

    // …while a legitimate narrowing still works: the point is "may narrow, may not
    // widen", not "filters are ignored".
    const about = await read({
      collection: 'pages',
      host: 'acme.localhost',
      where: { slug: { equals: 'about' } },
    })

    expect(about).toHaveLength(1)
  })

  it('still do not see drafts, and a scoped read is not how one leaks', async () => {
    const titles = (await read({ collection: 'pages', host: 'acme.localhost' })).map(
      (doc) => doc.slug,
    )

    expect(titles).not.toContain('coming-soon')
  })

  it('scope media and categories too, not only content', async () => {
    for (const collection of ['media', 'categories']) {
      const onAcme = await read({ collection, host: 'acme.localhost' })
      const onStudio = await read({ collection, host: 'studio.localhost' })

      for (const docs of [onAcme, onStudio]) {
        expect(new Set(docs.map((doc) => idOf(doc.site))).size).toBeLessThanOrEqual(1)
      }

      const sites = new Set([...onAcme, ...onStudio].map((doc) => idOf(doc.site)))

      // Only a real assertion if both hosts have rows: an empty library on one side
      // would pass a scoping test vacuously.
      if (onAcme.length && onStudio.length) {
        expect(sites.size).toBe(2)
        expect(sites).toEqual(new Set([acmeId.value, studioId.value]))
      }
    }
  })

  it('scope the search index like the content it mirrors', async () => {
    /**
     * The index is a copy of published content, so it needs the same scope or it becomes
     * the side door around `src/access/siteRead.ts`: `?where` on `/api/search` would list
     * another tenant's titles and SEO descriptions.
     */
    const onAcme = await read({ collection: 'search', host: 'acme.localhost' })
    const onStudio = await read({ collection: 'search', host: 'studio.localhost' })

    expect(onAcme.length).toBeGreaterThan(0)
    expect(new Set(onAcme.map((doc) => idOf(doc.site)))).toEqual(new Set([acmeId.value]))
    expect(new Set(onStudio.map((doc) => idOf(doc.site)))).toEqual(new Set([studioId.value]))
  })

  it('give a renderer only the one theme that belongs to the host', async () => {
    const acmeTheme = await read<Record<string, unknown>>({
      collection: 'theme',
      host: 'acme.localhost',
    })
    const studioTheme = await read<Record<string, unknown>>({
      collection: 'theme',
      host: 'studio.localhost',
    })

    expect(acmeTheme).toHaveLength(1)
    expect(acmeTheme[0]?.primary).toBe('#0f766e')
    expect(studioTheme).toHaveLength(1)
    expect(studioTheme[0]?.primary).toBe('#7c3aed')
  })

  it('never read a store’s payment instructions off the public API', async () => {
    const store = await read<Record<string, unknown>>({
      collection: 'store',
      host: 'shop.localhost',
    })

    expect(store).toHaveLength(1)
    expect(store[0]?.currency).toBe('IRT')
    // Field access, not this endpoint's select: the collection read is public so a
    // storefront can format prices, and a card number must not ride along with it.
    // Asserted on the serialized row because Payload *omits* an inaccessible field —
    // `undefined` and `null` would both be an acceptable shape, a leaked string is not.
    expect(JSON.stringify(store)).not.toContain('۶۰۳۷')
  })

  it('are refused outright on a host that is not a customer', async () => {
    // The control plane (and any domain no customer owns) resolves to no site. An
    // anonymous caller there has no tenant it could be asking about, so access is
    // denied — never every tenant's rows, which is what this used to return and
    // what made the admin hostname an unauthenticated index of the whole platform.
    //
    // Denied, not empty: access returning `false` makes Payload throw rather than
    // answer with no documents, which is why this asserts a rejection. Over REST
    // that is a 403 — a better answer than an empty list, since it does not
    // pretend the platform holds nothing.
    for (const collection of ['pages', 'posts', 'products', 'categories', 'media'] as const) {
      await expect(
        read({ collection, host: 'localhost' }),
        `${collection} was readable on a non-customer host`,
      ).rejects.toThrow()
    }
  })
})

describe('GET /api/site', () => {
  const fetchDescriptor = (host: string) =>
    createLocalReq(
      {
        req: {
          headers: new Headers({ host, method: 'GET' }),
          method: 'GET',
          url: `http://${host}/api/site`,
        } as Partial<PayloadRequest>,
      },
      payload,
    ).then((req) => siteDescriptor.handler(req))

  it('describes the site the request arrived on', async () => {
    const response = await fetchDescriptor('shop.localhost')

    expect(response.status).toBe(200)

    const site = (await response.json()) as Record<string, never | string | string[]>

    expect(site).toMatchObject({
      availableLocales: ['fa'],
      defaultLocale: 'fa',
      domain: 'shop.localhost',
      type: 'store',
    })

    // The block list is the admin's own table, so a renderer that switches on it and a
    // page that was saved through it cannot drift apart silently.
    expect(site.blocks).toContain('productGrid')
    expect(site.blocks).not.toContain('gallery')
  })

  it('carries the currency and the theme a renderer needs before first paint', async () => {
    const site = (await (await fetchDescriptor('shop.localhost')).json()) as {
      media?: { basePath?: string; origin?: string }
      store?: { currency?: string; paymentProvider?: string }
      theme?: { primary?: string } | null
    }

    // Prices without a unit are an order of magnitude waiting to happen: the descriptor
    // is how a separate app knows to print «تومان» at all.
    expect(site.store).toMatchObject({ currency: 'IRT', paymentProvider: 'bank' })
    expect(site.theme?.primary).toBeTruthy()
    // Locally-stored uploads are relative paths; the origin says which host resolves them.
    expect(site.media?.origin).toContain('shop.localhost')
    expect(site.media?.basePath).toBe('/api/media/file')
  })

  it('does not include the fields a visitor has no business reading', async () => {
    const raw = JSON.stringify(await (await fetchDescriptor('shop.localhost')).json())

    expect(raw).not.toContain('۶۰۳۷')
    expect(raw).not.toContain('domainVerified')
    expect(raw).not.toContain('tenants')
  })

  it('404s an unknown host rather than listing the platform', async () => {
    const response = await fetchDescriptor('nobody.localhost')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown-host' })
  })
})
