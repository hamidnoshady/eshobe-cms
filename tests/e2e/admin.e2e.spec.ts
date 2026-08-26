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

  /**
   * Opens one named site's `/about` page in the editor.
   *
   * Not by clicking the row: the list view re-renders as it syncs `?depth=1&limit=10`
   * into the URL, so a click lands on a node that is about to be replaced and the
   * navigation is silently dropped — the link ends up focused and nothing happens.
   * Asking the API also pins *which* «درباره ما», which matters because a platform
   * admin sees one per site and their order is not fixed.
   */
  const openAboutPage = async (domain: string): Promise<void> => {
    const res = await page.request.get(
      'http://localhost:3000/api/pages?where[slug][equals]=about&depth=1&limit=100',
    )
    const { docs } = (await res.json()) as { docs: { id: string; site: { domain: string } }[] }
    const doc = docs.find((d) => d.site?.domain === domain)

    expect(doc, `no /about page seeded for ${domain}`).toBeTruthy()

    await page.goto(`http://localhost:3000/admin/collections/pages/${doc!.id}`)
    // 30s: a cold doc-edit view in the dev server streams the shell first and compiles
    // the field components after, so the default 5s catches a page that has a sidebar
    // and no form yet.
    await expect(page.locator('input[name="title"]')).toBeVisible({ timeout: 30_000 })
  }

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

  test('previews a page on its own domain, at its canonical URL', async () => {
    /**
     * The preview button is the Wave 3 deliverable, and every part of this URL was
     * wrong before: the template built it from the *admin's* origin with no locale
     * segment and `/home` for the front page — a link into a domain the customer
     * does not own.
     */
    await openAboutPage('acme.localhost')

    const preview = page.getByRole('link', { name: /پیش‌نمایش|Preview/i }).first()

    await expect(preview).toHaveAttribute(
      'href',
      /^http:\/\/acme\.localhost:3000\/next\/preview\?path=%2Fabout/,
    )
  })

  test('shows a Gregorian date back to the editor in Shamsi', async () => {
    /**
     * The Wave 3 decision on the Jalali picker (PLAN §3.6): keep Payload's Gregorian
     * picker, echo the value in the calendar the editor actually thinks in. A wrong
     * year is the mistake this catches, and it costs no calendar code.
     */
    await openAboutPage('acme.localhost')

    /**
     * `MM/dd/yyyy`, which is what Payload's `pickerAppearance: 'default'` hands
     * react-datepicker as its `dateFormat`. An ISO string looks more obviously correct
     * and is the bug: the picker parses typed text against that format only, so
     * `2026-03-21` moved the calendar to March and committed nothing, leaving the field
     * empty and the hint unrendered.
     */
    await page.locator('#field-publishedAt input').fill('03/21/2026')

    // The hint's own class, not a descendant of `#field-publishedAt`: Payload renders a
    // field's Description as a *sibling* of that wrapper, and the wrapper holds the
    // picker popup whose year list runs 1900–2100 — a bare year match there is vacuous.
    const hint = page.locator('.shamsi-date-hint')

    // 1 Farvardin 1405 — Nowruz. Digits are Persian-Indic because the hint goes
    // through `formatDate`, like every other date on the platform.
    await expect(hint).toContainText('۱۴۰۵')
    await expect(hint).toContainText('فروردین')
  })

  test('shows an unsaved edit in the preview iframe, on the site’s own domain', async () => {
    /**
     * The Wave 3 acceptance criterion, and the reason it is an e2e test rather than a
     * unit one: every part of it that broke, broke *between* the two origins. The
     * admin is on `localhost` and the page on `acme.localhost`, so
     *
     *   - `RefreshRouteOnSave`'s `serverURL` has to be the admin's origin (it is both
     *     the `postMessage` target and the sender check), not the site's;
     *   - the iframe needs `frame-ancestors` naming the admin, or it never paints;
     *   - the editor's session cookie is not sent to the site at all, so the token is
     *     handed over in the preview URL and re-set as a cookie there;
     *   - Next's draft cookie is `SameSite=Lax` in dev, which a cross-site iframe
     *     drops — so draft mode was off again by the time the page rendered.
     *
     * Each of those fails silently: the pane loads the *published* page and simply
     * stops updating. Only an assertion on fresh text inside the frame catches it.
     */
    await openAboutPage('acme.localhost')

    /**
     * Live preview is a mode of the edit view, not a route: Payload keeps it in the
     * user's `editViewType` preference and renders the pane in place. `/…/<id>/preview`
     * is simply a 404. The toggler is also only rendered when `livePreview.url` returned
     * something, so clicking it at all proves the URL resolved for this document.
     */
    await page.locator('#live-preview-toggler').click()

    const frame = page.locator('#live-preview-iframe')
    await expect(frame).toHaveAttribute('src', /^http:\/\/acme\.localhost:3000\/next\/preview\?/)

    // Autosave writes a draft version and the iframe re-renders; the published page a
    // visitor sees keeps the old heading, which `frontend.e2e.spec.ts` asserts.
    //
    // Getting to the field is two clicks because that is what an editor does: `layout`
    // sits in the «محتوا» tab, and the field is set `initCollapsed: true`, so every
    // block row starts shut. Both hide the input from the DOM's point of view.
    await page.getByRole('button', { name: 'محتوا' }).click()
    // Enter, not click: the row's «بدون عنوان» block-name input is laid over the
    // full-width toggle button and swallows the pointer. Keyboard activation is a real
    // editor path and needs no `force`.
    await page.locator('#layout-row-1 button.collapsible__toggle--collapsed').press('Enter')

    // Row 1 is the contact block — `_order` in Postgres is 1-based, field paths are not.
    const heading = `تماس با ما ${Date.now()}`
    await page.locator('#field-layout__1__heading').fill(heading)

    await expect(page.frameLocator('#live-preview-iframe').locator('body')).toContainText(heading, {
      timeout: 30_000,
    })
  })
})
