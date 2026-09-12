import { expect, request, test, type APIRequestContext } from '@playwright/test'

/**
 * The superadmin control plane over the real router.
 *
 * `tests/int/platform-saas.int.spec.ts` calls the handlers directly, which is
 * exactly how the routing bug this file exists to prevent would hide. Two ways a
 * correct handler still answers 404 or the wrong body in production:
 *
 *  1. **First-segment collision.** Payload dispatches `/api/<first-segment>/…`
 *     against the collection whose slug matches, and never falls back to
 *     `config.endpoints`. `/api/webhooks/test` would therefore 404 forever if it
 *     were registered at the top level instead of on the `webhooks` collection —
 *     the same bug `/api/api-keys/issue` shipped with once.
 *  2. **Ordering.** `platformControlEndpoints` declares `/platform/sites/:id`. If it
 *     were spread before the SaaS endpoints, `:id` would match the literal segment
 *     `quota` and `/platform/sites/<id>/quota` would answer **200 with a site
 *     document** — the worst possible failure, because every caller would parse it
 *     and silently see no limits.
 *
 * Both are invisible to a handler-level test and obvious here.
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

test.describe('platform control plane over HTTP', () => {
  let admin: APIRequestContext
  let anonymous: APIRequestContext
  let acmeId: string

  test.beforeAll(async () => {
    admin = await login('admin@eshobe.test')
    anonymous = await request.newContext({ baseURL: base })

    const sites = await (await admin.get('/api/sites?limit=100&depth=0')).json()
    const site = sites.docs.find((doc: { domain: string }) => doc.domain === 'acme.localhost')
    if (!site) throw new Error('acme.localhost missing — run `pnpm seed`')
    acmeId = site.id
  })

  test('answers the SaaS overview on the real router', async () => {
    const res = await admin.get('/api/platform/saas/overview')

    expect(res.status()).toBe(200)
    expect(res.headers()['cache-control']).toBe('no-store')

    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.overview.subscriptions).toBeTruthy()
    expect(Array.isArray(body.overview.billing.collected)).toBe(true)
  })

  test('routes the per-site sub-paths instead of letting /platform/sites/:id swallow them', async () => {
    /**
     * The ordering assertion. Each of these shares its prefix with the bare
     * `/platform/sites/:id` from `platformControl.ts`, so a mis-ordered spread
     * returns a **site document with status 200** rather than 404 — which is why the
     * body is checked and not only the status.
     */
    const quota = await admin.get(`/api/platform/sites/${acmeId}/quota`)
    expect(quota.status()).toBe(200)
    const quotaBody = await quota.json()
    expect(quotaBody.enforcement).toBeTruthy()
    expect(Array.isArray(quotaBody.lines)).toBe(true)
    // A site document would have these; the quota report must not.
    expect(quotaBody.domain).toBeUndefined()

    const entitlement = await admin.get(`/api/platform/sites/${acmeId}/entitlement`)
    expect(entitlement.status()).toBe(200)
    expect((await entitlement.json()).entitlement.limits).toBeTruthy()

    // …and the bare route still works, which is the other half of "ordering", not
    // "the specific one shadowed the general one".
    const site = await admin.get(`/api/platform/sites/${acmeId}`)
    expect(site.status()).toBe(200)
    expect((await site.json()).site.domain).toBe('acme.localhost')
  })

  test('serves the webhook lifecycle from the collection, not the top level', async () => {
    // A 404 here means these were moved back to `config.endpoints`. The 400 is the
    // handler refusing a missing id — which proves it ran.
    const res = await admin.post('/api/webhooks/test', { data: {} })

    expect(res.status(), 'POST /api/webhooks/test must reach a handler').toBe(400)
    expect((await res.json()).message).toContain('شناسه')

    const rotate = await admin.post('/api/webhooks/rotate-secret', { data: {} })
    expect(rotate.status()).toBe(400)

    const replay = await admin.post('/api/webhooks/replay', { data: {} })
    expect(replay.status()).toBe(400)
  })

  test('refuses the whole surface to an anonymous caller', async () => {
    for (const path of [
      '/api/platform/saas/overview',
      '/api/platform/plans',
      '/api/platform/subscriptions',
      '/api/platform/invoices',
      '/api/platform/plugins',
      '/api/platform/features',
      '/api/platform/audit',
      '/api/platform/settings',
    ]) {
      const res = await anonymous.get(path)
      expect(res.status(), path).toBe(403)
    }
  })

  test('lists plans and settings without ever emitting a secret', async () => {
    const settings = await (await admin.get('/api/platform/settings')).json()
    expect(settings.ok).toBe(true)
    expect(Array.isArray(settings.supportedEvents)).toBe(true)

    const plugins = await (await admin.get('/api/platform/plugins')).text()
    const webhooks = await (await admin.get('/api/webhooks?limit=100&depth=0')).text()

    // `enc:v1:` is the stored-ciphertext prefix and `whsec_` a live signing secret.
    // Neither may cross the wire — not even encrypted, which would hand an attacker
    // an offline target.
    for (const payload of [JSON.stringify(settings), plugins, webhooks]) {
      expect(payload).not.toContain('enc:v1:')
      expect(payload).not.toMatch(/whsec_[0-9a-f]{32}/)
    }
  })
})

test.describe('the operator panel', () => {
  /**
   * The nav split, in a browser, with the escape hatch *off*.
   *
   * `playwright.config.ts` sets `PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS=true` for the
   * whole run, because `admin.e2e.spec.ts` is about the editing experience. That
   * makes this the one place the flag is exercised in its default position — via a
   * direct request to the admin route rather than a second dev server.
   *
   * So this asserts what the flag does not affect: the control-plane collections are
   * present, grouped, and reachable for a platform admin.
   */
  test('puts the SaaS collections in the operator’s nav', async ({ page }) => {
    await page.goto(`${base}/admin/login`)
    await page.locator('#field-email').fill('admin@eshobe.test')
    await page.locator('#field-password').fill('test1234')
    await page.locator('form button[type="submit"]').click()
    await page.waitForURL(/\/admin(\?|$)/, { timeout: 60_000 })

    const nav = page.locator('.nav')
    for (const label of ['طرح‌ها', 'اشتراک‌ها', 'صورتحساب‌ها', 'وب‌هوک‌ها', 'گزارش ممیزی']) {
      await expect(nav.getByRole('link', { name: label }).first(), label).toBeVisible({ timeout: 30_000 })
    }

    // The groups themselves: an ungrouped collection lands above the named sections
    // and the console stops reading top-down.
    await expect(page.getByText('سکو — اشتراک و صورتحساب').first()).toBeVisible()
    await expect(page.getByText('سکو — عملیات').first()).toBeVisible()
  })

  test('greets the operator with the platform report, not a grid of content counts', async ({ page }) => {
    await page.goto(`${base}/admin/login`)
    await page.locator('#field-email').fill('admin@eshobe.test')
    await page.locator('#field-password').fill('test1234')
    await page.locator('form button[type="submit"]').click()
    await page.waitForURL(/\/admin(\?|$)/, { timeout: 60_000 })

    await expect(page.getByRole('heading', { name: 'کنسول مدیریت سکو' })).toBeVisible({ timeout: 60_000 })
    // The dashboard is rendered from the same functions the API returns, so a broken
    // report shows the fallback banner rather than these sections.
    await expect(page.getByText('ناوگان سایت‌ها')).toBeVisible()
    await expect(page.getByText('اشتراک و درآمد')).toBeVisible()
  })
})
