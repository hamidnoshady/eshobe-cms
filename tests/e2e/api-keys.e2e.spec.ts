import { expect, request, test, type APIRequestContext } from '@playwright/test'

/**
 * WAVE-9 §9.4 over the real router. `tests/int/api-keys.int.spec.ts` calls the
 * endpoint handlers directly, which is exactly how the routing bug hid: the three
 * lifecycle endpoints were registered at the top level, where an API path whose
 * first segment is a collection slug never looks — `api-keys` is a collection, so
 * `/api/api-keys/issue` answered 404 "Route not found" to every real caller while
 * the int suite stayed green. They live on the collection now; this spec pins that
 * over HTTP, so moving them back (or a new endpoint making the same mistake) fails
 * here first.
 *
 * It also pins the admin-facing half of the fix: the collection's own create route
 * is closed (`access.create` is `false`), because a key created that way is a
 * credential nobody can ever read back — the raw value exists only in the minting
 * request, and only `/issue` hands it out.
 *
 * Run `pnpm seed` first.
 */
const base = 'http://localhost:3000'

const login = async (email: string): Promise<APIRequestContext> => {
  const ctx = await request.newContext({ baseURL: base })
  const res = await ctx.post('/api/users/login', {
    data: { email, password: 'test1234' },
  })

  expect(res.status(), `login as ${email}`).toBe(200)

  return ctx
}

test.describe('api-keys lifecycle over HTTP', () => {
  let admin: APIRequestContext
  let shopId: string
  let studioId: string

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')

    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const byDomain = (domain: string) => {
      const site = sites.docs.find((doc: { domain: string }) => doc.domain === domain)
      if (!site) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)
      return site.id as string
    }
    shopId = byDomain('shop.localhost')
    studioId = byDomain('studio.localhost')
  })

  test('issue answers on the real router and returns the raw key once', async () => {
    const res = await admin.post('/api/api-keys/issue', {
      data: { name: 'e2e lifecycle key', role: 'site', siteId: shopId },
    })

    // This was 404 "Route not found" while the endpoints sat in config.endpoints.
    expect(res.status()).toBe(201)

    const issued = await res.json()
    expect(issued.key).toMatch(/^eshobe_live_[0-9a-f]{40}$/)
    expect(issued.prefix).toBe(issued.key.slice(0, issued.prefix.length))
  })

  test('issue → use → list → revoke, the shape the POS client drives', async () => {
    const issued = await (
      await admin.post('/api/api-keys/issue', {
        data: { name: 'e2e use-and-revoke key', role: 'site', siteId: shopId },
      })
    ).json()
    expect(issued.key).toMatch(/^eshobe_live_/)

    // The realistic client: the site's own domain as Host, the key as the bearer
    // credential (`cafe-restaurant-pos`'s `src/lib/cms/client.ts`).
    const asKey = await request.newContext({
      baseURL: base,
      extraHTTPHeaders: { authorization: `Bearer ${issued.key}`, host: 'shop.localhost' },
    })

    const ownProducts = await asKey.get('/api/products?limit=100&depth=0')
    expect(ownProducts.status()).toBe(200)
    const own = await ownProducts.json()
    expect(own.totalDocs).toBeGreaterThan(0)
    // `depth=0` leaves `site` as the raw id — an object here would mean the query
    // was not key-scoped at all.
    expect(own.docs.every((doc: { site: string }) => doc.site === shopId)).toBe(true)
    // Holding the key is what unlocks drafts, not the Host: the seed leaves one
    // draft product that an anonymous visitor on the same Host never sees.
    expect(own.docs.some((doc: { _status: string }) => doc._status === 'draft')).toBe(true)

    // A `where` naming another site's rows intersects with the key's own site and
    // yields nothing — narrow, never widen.
    const widened = await asKey.get(
      `/api/products?limit=100&depth=0&where[site][equals]=${studioId}`,
    )
    expect(widened.status()).toBe(200)
    expect((await widened.json()).totalDocs).toBe(0)

    // The masked list: the row is there, the raw key is not.
    const list = await admin.get(`/api/api-keys/list?siteId=${shopId}`)
    expect(list.status()).toBe(200)
    const listed = await list.json()
    const row = listed.docs.find((doc: { id: string }) => doc.id === issued.id)
    expect(row?.prefix).toBe(issued.key.slice(0, row.prefix.length))
    expect(JSON.stringify(listed)).not.toContain(issued.key)

    // Revoke, and the same request degrades to an anonymous visitor on that Host:
    // published rows still answer (the site must not break with the key), but the
    // draft the key could see a moment ago is gone.
    const revoked = await admin.post('/api/api-keys/revoke', { data: { id: issued.id } })
    expect(revoked.status()).toBe(200)

    const afterRevoke = await asKey.get('/api/products?limit=100&depth=0')
    expect(afterRevoke.status()).toBe(200)
    const published = await afterRevoke.json()
    expect(published.docs.every((doc: { _status: string }) => doc._status === 'published')).toBe(true)

    const draftsAfterRevoke = await asKey.get(
      '/api/products?limit=100&depth=0&where[_status][equals]=draft',
    )
    expect(draftsAfterRevoke.status()).toBe(200)
    expect((await draftsAfterRevoke.json()).totalDocs).toBe(0)
  })

  test('the collection create route is closed — only the issuer can mint', async () => {
    // A key created through REST/GraphQL/admin form is a credential nobody can ever
    // see again (the mint runs in a hook; the raw value never persists), so the
    // route is `false`, not merely discouraged. See `src/collections/ApiKeys.ts`.
    const res = await admin.post('/api/api-keys', {
      data: { name: 'must not exist', role: 'platform' },
    })
    expect(res.status()).toBe(403)
  })
})

test.describe('the same routing rule on storage-connections', () => {
  test('self-test reaches its handler, not the 404 fallback', async () => {
    const admin = await login('admin@eshobe.test')

    // `storage-connections` is a collection slug too — this endpoint was equally
    // unreachable from the top level. An invalid id answers 400 from the handler;
    // 404 would mean the router never found it.
    const res = await admin.post('/api/storage-connections/self-test', { data: {} })
    expect(res.status()).toBe(400)
  })
})
