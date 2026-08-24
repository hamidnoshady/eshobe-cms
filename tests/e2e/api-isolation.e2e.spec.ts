import { expect, request, test, type APIRequestContext } from '@playwright/test'

/**
 * PLAN §8.6 over HTTP. `tests/int/tenancy.int.spec.ts` proves the access layer scopes
 * a Local API `find`; this proves the surface a browser actually hits — the REST
 * endpoint every admin list view and relationship picker queries — is scoped too. A
 * picker is a `GET /api/pages`, so the leak it could show is the one asserted here.
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

test.describe('REST isolation', () => {
  let admin: APIRequestContext
  let acmeOwner: APIRequestContext
  let acmeId: string
  let studioPageId: string

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')
    acmeOwner = await login('acme@eshobe.test')

    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const byDomain = (domain: string) => {
      const site = sites.docs.find((doc: { domain: string }) => doc.domain === domain)
      if (!site) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)
      return site.id as string
    }
    acmeId = byDomain('acme.localhost')

    const pages = await (
      await admin.get(`/api/pages?limit=100&depth=0&where[site][equals]=${byDomain('studio.localhost')}`)
    ).json()
    studioPageId = pages.docs[0]?.id
    expect(studioPageId, 'studio has at least one page').toBeTruthy()
  })

  test.afterAll(async () => {
    await admin.dispose()
    await acmeOwner.dispose()
  })

  test('lists only the caller’s own site’s pages', async () => {
    const body = await (await acmeOwner.get('/api/pages?limit=100&depth=0')).json()

    expect(body.docs.length).toBeGreaterThan(0)
    expect(body.docs.map((doc: { site: string }) => doc.site)).toEqual(
      body.docs.map(() => acmeId),
    )
    expect(body.docs.map((doc: { id: string }) => doc.id)).not.toContain(studioPageId)
  })

  test('ignores a where clause aimed at another site', async () => {
    // What a hand-edited picker request looks like: the plugin ANDs its constraint on,
    // so an explicit `where` cannot widen the result set.
    const body = await (
      await acmeOwner.get(`/api/pages?limit=100&depth=0&where[id][equals]=${studioPageId}`)
    ).json()

    expect(body.docs).toEqual([])
  })

  test('does not serve another site’s page by id', async () => {
    expect((await acmeOwner.get(`/api/pages/${studioPageId}`)).status()).toBe(404)
  })
})
