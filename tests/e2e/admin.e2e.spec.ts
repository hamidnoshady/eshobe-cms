import { expect, test, type Page } from '@playwright/test'
import { login } from '../helpers/login'
import { seedTestUser, cleanupTestUser, testUser } from '../helpers/seedUser'

/**
 * PLAN §8.4: the admin chrome renders in Persian, right-to-left. `testUser` is a
 * platform admin, so what it sees is the control plane, not one customer's view —
 * tenant scoping is covered against the real access layer in
 * `tests/int/tenancy.int.spec.ts`.
 */
test.describe('Admin Panel', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    await seedTestUser()

    const context = await browser.newContext()
    page = await context.newPage()

    await login({ page, user: testUser })
  })

  test.afterAll(async () => {
    await cleanupTestUser()
  })

  test('renders in Persian, right-to-left', async () => {
    await page.goto('http://localhost:3000/admin')

    await expect(page.locator('html')).toHaveAttribute('lang', 'fa')
    // Case-insensitive: Payload's admin layout writes `dir="RTL"`.
    await expect(page.locator('html')).toHaveAttribute('dir', /^rtl$/i)
  })

  test('names collections in Persian', async () => {
    await page.goto('http://localhost:3000/admin/collections/pages')

    // The collection's own `labels`, not Payload's dictionary — an English "Pages"
    // here means a collection was added without them.
    await expect(page.locator('h1', { hasText: 'برگه‌ها' }).first()).toBeVisible()
  })

  test('calls the tenant selector a site, not a lodger', async () => {
    // The plugin's own fa translation for "tenant" is "مستاجر". Overriding it has to
    // happen in the plugin's `i18n` option — a `payload.config` override is silently
    // discarded (the plugin overwrites its whole namespace).
    await page.goto('http://localhost:3000/admin')

    await expect(page.getByText('سایت', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('مستاجر')).toHaveCount(0)
  })

  test('can open the create-page form', async () => {
    await page.goto('http://localhost:3000/admin/collections/pages/create')

    await expect(page).toHaveURL(/\/admin\/collections\/pages\/[a-zA-Z0-9-_]+/)
    await expect(page.locator('input[name="title"]')).toBeVisible()
  })

  test('translates plugin field labels instead of printing their i18n keys', async () => {
    // `plugin-redirects` ships en/es/fr/ja/pt/sv and no fa, so its labels rendered as
    // raw `plugin-redirects:fromUrl` keys. Any future plugin with a thin dictionary
    // fails here rather than shipping.
    await page.goto('http://localhost:3000/admin/collections/redirects/create')

    await expect(page.getByText('از نشانی', { exact: false }).first()).toBeVisible()
    await expect(page.getByText(/plugin-[a-z-]+:[a-zA-Z]+/)).toHaveCount(0)
  })
})
