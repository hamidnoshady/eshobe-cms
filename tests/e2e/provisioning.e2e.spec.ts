import { expect, request, test, type APIRequestContext } from '@playwright/test'

/**
 * Wave 5 over HTTP: one action provisions a site, the site serves its seeded
 * content on its own domain in both locales, and a suspended site serves the
 * holding page — not its content, and not an error.
 *
 * API-driven (like `api-isolation.e2e.spec.ts`) so it pins the endpoint
 * contract rather than the admin form's markup.
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

/** The endpoint's JSON: a summary on success, field errors on failure. */
type ProvisionResponse = {
  errors?: { path: string }[]
  message?: string
  site?: { id: string; url: string }
  summary?: { pages: number }
}

const provision = (
  ctx: APIRequestContext,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; response: ProvisionResponse }> =>
  ctx
    .post('/api/provision-site', { data })
    .then(async (res) => ({ ok: res.ok(), response: (await res.json()) as ProvisionResponse }))

test.describe('provisioning a new site', () => {
  let admin: APIRequestContext

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')
  })

  /** A previous run's sites, so re-runs do not trip the unique domain. */
  const cleanUp = async (...domains: string[]) => {
    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const ids = sites.docs
      .filter((doc: { domain: string }) => domains.includes(doc.domain))
      .map((doc: { id: string }) => doc.id as string)

    for (const id of ids) {
      // Users first: their `tenants` rows reference the site, and the plugin's
      // cascade cleanup is deliberately off.
      await admin.delete(`/api/users?where[tenants.tenant][equals]=${id}`)

      for (const collection of ['pages', 'header', 'footer', 'theme', 'forms']) {
        await admin.delete(`/api/${collection}?where[site][equals]=${id}`)
      }

      await admin.delete(`/api/sites/${id}`)
    }
  }

  test.afterAll(async () => {
    await cleanUp('e2e-provisioned.localhost', 'e2e-suspended.localhost')
    await admin.dispose()
  })

  test('refuses a non-admin caller', async () => {
    const acmeOwner = await login('acme@eshobe.test')
    const { ok } = await provision(acmeOwner, {
      defaultLocale: 'fa',
      domain: 'not-allowed.localhost',
      locales: ['fa'],
      name: 'غیرمجاز',
      type: 'business',
      users: [],
    })

    expect(ok).toBe(false)

    await acmeOwner.dispose()
  })

  test('rejects a duplicate domain with the field named', async () => {
    const { ok, response } = await provision(admin, {
      defaultLocale: 'fa',
      domain: 'acme.localhost',
      locales: ['fa'],
      name: 'تکراری',
      type: 'business',
      users: [],
    })

    expect(ok).toBe(false)
    expect(response.errors).toContainEqual(expect.objectContaining({ path: 'domain' }))
  })

  test('goes from nothing to serving seeded content in one action', async ({ request: browserless }) => {
    const { ok, response } = await provision(admin, {
      defaultLocale: 'fa',
      domain: 'e2e-provisioned.localhost',
      locales: ['fa', 'en'],
      name: 'فروشگاه آزمایشی',
      type: 'store',
      users: [{ email: 'e2e-owner@eshobe.test', role: 'owner' }],
    })

    expect(ok).toBe(true)

    // From nothing to populated: the starter pages, the nav, the footer, the
    // theme and the form — in both of the site's locales.
    expect(response.summary?.pages).toBe(4)

    const siteUrl = response.site?.url
    expect(siteUrl).toBeTruthy()

    // The Persian home page on the customer's own domain.
    const fa = await browserless.get(`${siteUrl}/`)
    const faBody = await fa.text()

    expect(fa.status()).toBe(200)
    expect(faBody).toContain('به فروشگاه ما خوش آمدید')
    expect(faBody).toContain('محصولات')

    // …and its English translation at /en — translated content, translated nav.
    const en = await browserless.get(`${siteUrl}/en`)
    const enBody = await en.text()

    expect(en.status()).toBe(200)
    expect(enBody).toContain('Welcome to our shop')
    expect(enBody).toContain('Products')
  })

  test('a suspended site serves a holding page, not its content', async ({ request: browserless }) => {
    const { response } = await provision(admin, {
      defaultLocale: 'fa',
      domain: 'e2e-suspended.localhost',
      locales: ['fa'],
      name: 'معلق',
      type: 'business',
      users: [],
    })

    const siteId = response.site?.id as string
    const siteUrl = response.site?.url as string

    // Its content is reachable while active…
    const live = await browserless.get(`${siteUrl}/`)
    expect(await live.text()).toContain('آمادهٔ شروع هستید؟')

    const suspended = await admin.patch(`/api/sites/${siteId}`, { data: { status: 'suspended' } })
    expect(suspended.ok()).toBe(true)

    // …and every path answers with the holding page once suspended.
    const held = await browserless.get(`${siteUrl}/`)
    const heldBody = await held.text()

    expect(held.status()).toBe(200)
    expect(heldBody).toContain('موقتاً در دسترس نیست')

    // Not the site's own content…
    expect(heldBody).not.toContain('آمادهٔ شروع هستید؟')

    // …and not indexed: a suspension is not the site's answer to search engines.
    expect(heldBody).toContain('<meta name="robots" content="noindex')

    const deep = await browserless.get(`${siteUrl}/about`)
    expect(await deep.text()).toContain('موقتاً در دسترس نیست')
  })
})
