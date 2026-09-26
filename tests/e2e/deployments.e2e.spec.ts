import { expect, request, test, type APIRequestContext } from '@playwright/test'

/**
 * The Wave 11 deployment surface over the real router.
 *
 * `tests/int/deploy-lifecycle.int.spec.ts` calls the handlers directly, which is
 * exactly how a routing bug would hide: every `/platform/sites/:id/deployment/<word>`
 * shares its prefix with the bare `/platform/sites/:id` from `platformControl.ts`, and
 * `/api/site-theme-settings/current` only routes if it is a *collection* endpoint.
 * Each assertion below checks a body only the intended handler produces — a status
 * alone would pass on the wrong route.
 *
 * No Coolify and no GitHub are reached: every request here is refused or answered by
 * validation before any network work, which is the point — the handler ran.
 *
 * Run `pnpm seed` first.
 */
const base = 'http://localhost:3000'

const login = async (email: string): Promise<APIRequestContext> => {
  const ctx = await request.newContext({ baseURL: base })
  const res = await ctx.post('/api/users/login', { data: { email, password: 'test1234' } })
  expect(res.status(), `login as ${email}`).toBe(200)
  return ctx
}

test.describe('deployment routes over HTTP', () => {
  let admin: APIRequestContext
  let anonymous: APIRequestContext
  let withSiteKey: APIRequestContext
  let acmeId: string

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')
    anonymous = await request.newContext({ baseURL: base })

    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const site = sites.docs.find((doc: { domain: string }) => doc.domain === 'acme.localhost')
    if (!site) throw new Error('acme.localhost missing — run `pnpm seed`')
    acmeId = site.id

    const issued = await admin.post('/api/api-keys/issue', {
      data: { name: 'کلید سایت (e2e استقرار)', role: 'site', siteId: acmeId },
    })
    expect(issued.status()).toBe(201)
    const { key } = await issued.json()
    withSiteKey = await request.newContext({ baseURL: base, extraHTTPHeaders: { authorization: `Bearer ${key}` } })
  })

  test('POST …/theme-packages/github-webhook is registered and refuses anonymous callers', async () => {
    const res = await anonymous.post('/api/platform/theme-packages/github-webhook', {
      data: { ref: 'refs/heads/main' },
    })
    expect(res.status()).toBe(403)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('GET …/deployment reaches the deployment endpoint, not the bare site route', async () => {
    const res = await admin.get(`/api/platform/sites/${acmeId}/deployment`)
    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control']).toBe('no-store')

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.deployments)).toBe(true)
    expect(typeof body.needsRedeploy).toBe('boolean')
    expect(body.renderedBy).toBeTruthy()
    // The bare route answers `{ site: {...} }`.
    expect(body.site).toBeUndefined()
  })

  test('POST …/deployment/redeploy reaches the redeploy handler', async () => {
    // Refused by the redeploy handler's own validation, which runs before anything
    // else — only that handler produces this message for this path.
    const res = await admin.post(`/api/platform/sites/${acmeId}/deployment/redeploy`, { data: { ref: '../etc' } })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.message).toContain('شاخه')
  })

  test('the other lifecycle literals reach their handlers too', async () => {
    for (const tail of ['stop', 'rollback', 'poll', 'verify']) {
      const res = await admin.post(`/api/platform/sites/${acmeId}/deployment/${tail}`, { data: {} })
      expect(res.status(), tail).toBe(400)
      expect((await res.json()).message, tail).toContain('شناسهٔ استقرار')
    }
  })

  test('refuses a site key and an anonymous caller on the deployment family', async () => {
    const paths: [('get' | 'post'), string][] = [
      ['get', `/api/platform/sites/${acmeId}/deployment`],
      ['post', `/api/platform/sites/${acmeId}/deployment`],
      ['post', `/api/platform/sites/${acmeId}/deployment/redeploy`],
      ['post', `/api/platform/sites/${acmeId}/deployment/stop`],
      ['post', `/api/platform/sites/${acmeId}/deployment/rollback`],
      ['post', `/api/platform/sites/${acmeId}/deployment/revert`],
      ['get', '/api/platform/routing'],
      ['get', '/api/platform/theme-packages'],
    ]
    for (const ctx of [withSiteKey, anonymous]) {
      for (const [method, path] of paths) {
        const res = method === 'get' ? await ctx.get(path) : await ctx.post(path, { data: {} })
        expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(403)
      }
    }
  })

  test('serves the tenant theme settings from the collection, to the site’s own staff only', async () => {
    const asAdmin = await admin.get(`/api/site-theme-settings/current?site=${acmeId}`)
    expect(asAdmin.status(), 'a 404 means the route fell off the collection').toBe(200)
    const body = await asAdmin.json()
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.fields)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('enc:')

    const owner = await login('acme@eshobe.test')
    expect((await owner.get(`/api/site-theme-settings/current?site=${acmeId}`)).status()).toBe(200)

    const otherOwner = await login('shop@eshobe.test')
    expect((await otherOwner.get(`/api/site-theme-settings/current?site=${acmeId}`)).status()).toBe(403)
    expect((await withSiteKey.get(`/api/site-theme-settings/current?site=${acmeId}`)).status()).toBe(403)
    expect((await anonymous.get(`/api/site-theme-settings/current?site=${acmeId}`)).status()).toBe(403)
  })
})

test.describe('the deployment and theme-settings tabs', () => {
  test('render for an operator', async ({ page }) => {
    await page.goto(`${base}/admin/login`)
    await page.locator('#field-email').fill('admin@eshobe.test')
    await page.locator('#field-password').fill('test1234')
    await page.locator('form button[type="submit"]').click()
    await page.waitForURL(/\/admin(\?|$)/, { timeout: 60_000 })

    const sites = await (await page.request.get(`${base}/api/sites?limit=100&depth=0`)).json()
    const acme = sites.docs.find((doc: { domain: string }) => doc.domain === 'acme.localhost')

    await page.goto(`${base}/admin/collections/sites/${acme.id}/deployment`)
    await expect(page.getByRole('heading', { name: /استقرار پوسته/ }).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('heading', { name: 'اکنون چه چیزی سرویس می‌دهد؟' })).toBeVisible()
    await expect(page.getByText('با رندرکنندهٔ داخلی سرویس داده می‌شود')).toBeVisible()

    await page.goto(`${base}/admin/collections/sites/${acme.id}/theme-settings`)
    await expect(page.getByRole('heading', { name: /تنظیمات پوسته/ }).first()).toBeVisible({ timeout: 60_000 })
  })
})
