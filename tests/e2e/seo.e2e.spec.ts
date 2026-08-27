import { expect, test } from '@playwright/test'

/**
 * Wave 6 at the HTTP level: what a crawler and a social scraper get from a customer
 * domain. Run `pnpm seed` first.
 *
 * Every assertion is about a response body, so these read like API tests — but they
 * go through `page.goto`, whose return value *is* the response. The `request`
 * fixture would be the natural choice and cannot be used: it resolves hostnames with
 * Node, which does not know `*.localhost` (CLAUDE.md), while Chromium resolves it
 * itself. Same reason the browser tests need no hosts-file entry.
 */
const acme = 'http://acme.localhost:3000'
const studio = 'http://studio.localhost:3000'
const unknown = 'http://nobody.localhost:3000'

test.describe('robots.txt', () => {
  test('names the site’s own sitemap', async ({ page }) => {
    const response = await page.goto(`${acme}/robots.txt`)

    expect(response?.status()).toBe(200)
    const body = (await response?.text()) ?? ''

    expect(body).toContain(`Sitemap: ${acme}/sitemap.xml`)
    expect(body).toContain('Disallow: /admin')
    // The build-time file this replaced named one origin for every tenant.
    expect(body).not.toContain('studio.localhost')
  })

  test('stops crawlers on a host that belongs to no site', async ({ page }) => {
    const body = (await (await page.goto(`${unknown}/robots.txt`))?.text()) ?? ''

    expect(body).toContain('Disallow: /')
    expect(body).not.toContain('Sitemap:')
  })
})

test.describe('sitemap.xml', () => {
  test('lists only this site’s pages, in every locale it serves', async ({ page }) => {
    const response = await page.goto(`${acme}/sitemap.xml`)

    expect(response?.headers()['content-type']).toContain('application/xml')

    const body = (await response?.text()) ?? ''

    expect(body).toContain(`<loc>${acme}/about</loc>`)
    expect(body).toContain(`<loc>${acme}/en/about</loc>`)
    // The home page is `/`, never `/home`, and never with a trailing slash.
    expect(body).toContain(`<loc>${acme}</loc>`)
    expect(body).not.toContain('/home')
    expect(body).not.toContain('studio.localhost')
    // Reciprocal alternates, and the namespace that makes them valid XML.
    expect(body).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(body).toContain(`hreflang="en" href="${acme}/en/about"`)
  })

  test('a single-locale site advertises no alternates', async ({ page }) => {
    const body = (await (await page.goto(`${studio}/sitemap.xml`))?.text()) ?? ''

    expect(body).toContain(`<loc>${studio}/about</loc>`)
    expect(body).not.toContain('hreflang')
  })

  test('404s on a host that belongs to no site', async ({ page }) => {
    expect((await page.goto(`${unknown}/sitemap.xml`))?.status()).toBe(404)
  })
})

test.describe('hreflang', () => {
  test('every locale of a document points at the others', async ({ page }) => {
    const html = (await (await page.goto(`${acme}/en/about`))?.text()) ?? ''

    expect(html).toContain(`hrefLang="fa" href="${acme}/about"`)
    expect(html).toContain(`hrefLang="en" href="${acme}/en/about"`)
    expect(html).toContain(`hrefLang="x-default" href="${acme}/about"`)
  })

  test('a single-locale site emits none', async ({ page }) => {
    const html = (await (await page.goto(`${studio}/about`))?.text()) ?? ''

    expect(html).not.toContain('hrefLang')
    expect(html).toContain(`rel="canonical" href="${studio}/about"`)
  })
})

test.describe('OG image', () => {
  test('renders a PNG card per locale', async ({ page }) => {
    for (const locale of ['fa', 'en']) {
      const response = await page.goto(`${acme}/og?slug=about&locale=${locale}`)

      expect(response?.status()).toBe(200)
      expect(response?.headers()['content-type']).toContain('image/png')
      // A card whose font failed to load is still a valid PNG — a nearly empty one.
      expect((await response?.body())?.byteLength ?? 0).toBeGreaterThan(5_000)
    }
  })

  test('the page points at its own locale’s card', async ({ page }) => {
    const html = (await (await page.goto(`${acme}/en/about`))?.text()) ?? ''

    expect(html).toContain(`${acme}/og?locale=en&amp;slug=about`)
  })

  test('refuses a slug that is not a published page', async ({ page }) => {
    // The card renders database content, never a `?title=` from the URL — otherwise
    // anyone could publish arbitrary text on the customer's branded image.
    expect((await page.goto(`${acme}/og?slug=not-a-page`))?.status()).toBe(404)
    expect((await page.goto(`${unknown}/og`))?.status()).toBe(404)
  })
})
