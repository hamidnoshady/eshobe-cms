import { expect, test, type Page } from '@playwright/test'

/**
 * PLAN §8.2, §8.3 and §8.5 at the HTTP level — which domain serves which content,
 * which locale a URL is in, and what an anonymous visitor must never see. Run
 * `pnpm seed` first.
 *
 * Chromium resolves `*.localhost` to loopback itself, so these need no hosts-file
 * entry — unlike `curl` and Node's resolver on Windows (see CLAUDE.md).
 */
const acme = 'http://acme.localhost:3000'
const studio = 'http://studio.localhost:3000'

test.describe('site routing', () => {
  test('each domain serves its own home page and not the other’s', async ({ page }) => {
    await page.goto(acme)
    await expect(page.locator('body')).toContainText('آکمه')
    await expect(page.locator('body')).not.toContainText('استودیو نقش')

    await page.goto(studio)
    await expect(page.locator('body')).toContainText('استودیو نقش')
    await expect(page.locator('body')).not.toContainText('آکمه')
  })

  test('serves the site’s default locale RTL and its other locale LTR', async ({ page }) => {
    await page.goto(acme)
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa')
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

    await page.goto(`${acme}/en`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await expect(page.locator('body')).toContainText('Industrial supply')
  })

  test('keeps the locale on every internal link', async ({ page }) => {
    // A nav that drops the segment sends an English visitor back to the Persian
    // page, which is worse than no translation at all.
    await page.goto(`${acme}/en`)
    await page.getByRole('link', { name: 'درباره ما' }).click()

    await expect(page).toHaveURL(`${acme}/en/about`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('has no route for a locale the site does not serve', async ({ page }) => {
    // studio serves `fa` only. Without the guard this rendered studio's Persian
    // home page on an English URL — duplicate content on a URL that must not exist.
    expect((await page.goto(`${studio}/en`))?.status()).toBe(404)
  })

  test('has no route for an unknown host', async ({ page }) => {
    // The leak this catches: with no host resolution, plain `localhost` served
    // whichever site the query happened to return first.
    expect((await page.goto('http://localhost:3000/'))?.status()).toBe(404)
  })

  test('does not serve a draft page to an anonymous visitor', async ({ page }) => {
    expect((await page.goto(`${acme}/coming-soon`))?.status()).toBe(404)
    await expect(page.locator('body')).not.toContainText('این صفحه هنوز منتشر نشده است')
  })
})

test.describe('per-site theme', () => {
  /** The tokens as the browser resolved them, not as the CSS was written. */
  const tokens = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const style = getComputedStyle(document.body)

      return {
        leading: style.lineHeight,
        primary: style.getPropertyValue('--primary').trim(),
        radius: style.getPropertyValue('--radius').trim(),
      }
    })

  test('two sites compute different tokens from the same build', async ({ page }) => {
    // PLAN Wave 2: theming is per-site *data*, so this must hold with no rebuild
    // between the two navigations.
    await page.goto(acme)
    const a = await tokens(page)

    await page.goto(studio)
    const s = await tokens(page)

    expect(a).toEqual({ leading: '28.8px', primary: '#0f766e', radius: '0.25rem' })
    expect(s).toEqual({ leading: '30.4px', primary: '#7c3aed', radius: '1rem' })
  })

  test('leaves the dark theme working over a site’s own background', async ({ page }) => {
    // A site's light background declared unconditionally on `body` would beat
    // `[data-theme='dark']` on `html`, and dark mode would silently do nothing.
    await page.goto(acme)

    const background = () =>
      page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--background').trim())

    expect(await background()).toBe('#ffffff')

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))

    // Not asserted as a literal: Lightning CSS rewrites the palette's `oklch()` to
    // `lab()`, so only "not the site's own light colour any more" is stable.
    expect(await background()).not.toBe('#ffffff')
  })
})

test.describe('block library', () => {
  test('keeps the Persian copy after the English translation pass', async ({ page }) => {
    // The §3.7 regression guard. `layout` is not localized, so writing a freshly
    // built array on the `en` locale *replaces* the rows and destroys the Persian
    // text inside them. This shipped once and stayed invisible because no test read
    // the body of a translated page — only its title.
    await page.goto(`${acme}/about`)
    await expect(page.locator('body')).toContainText('تأمین قطعات صنعتی از سال ۱۳۵۳')
    await expect(page.locator('body')).toContainText('تماس با ما')

    await page.goto(`${acme}/en/about`)
    await expect(page.locator('body')).toContainText('Industrial supply, since 1974')
    await expect(page.locator('body')).toContainText('Contact us')
  })

  test('renders a phone number readable but still dialable', async ({ page }) => {
    // Two separate requirements on one field: Persian-Indic digits are what a
    // Persian reader expects, and a `tel:` built from them does not dial.
    await page.goto(`${acme}/about`)

    const phone = page.getByRole('link', { name: /۰۲۱/ })
    await expect(phone).toHaveAttribute('href', 'tel:02112345678')
    await expect(phone).toContainText('۰۲۱۱۲۳۴۵۶۷۸')
  })

  test('shows a price in Persian digits and only where the site type allows it', async ({
    page,
  }) => {
    // acme is a business site, studio a portfolio: `filterOptions` in
    // `src/blocks/index.ts` is what keeps a price list off a portfolio.
    await page.goto(`${acme}/services`)
    await expect(page.locator('body')).toContainText('۲۹٬۰۰۰')
    await expect(page.locator('body')).not.toContainText('29,000')

    await page.goto(`${studio}/services`)
    await expect(page.locator('body')).not.toContainText('۲۹٬۰۰۰')
    await expect(page.locator('body')).not.toContainText('تعرفه‌ها')
  })

  test('opens an FAQ answer with no JavaScript of ours', async ({ page }) => {
    // `<details>`/`<summary>`: keyboard, screen-reader and RTL marker placement all
    // come from the platform. If this breaks, the accordion grew a JS dependency.
    await page.goto(`${acme}/services`)

    const answer = page.getByText('سفارش‌های تهران یک روز کاری')
    await expect(answer).toBeHidden()

    await page.getByText('ارسال چقدر طول می‌کشد؟').click()
    await expect(answer).toBeVisible()
  })
})

test.describe('contact form', () => {
  /**
   * Waits until React owns the form.
   *
   * `page.goto` resolves on `load`, which is *before* hydration, and a submit click in
   * that window falls through to the browser's own handler: a native GET that puts the
   * visitor's message in the query string and navigates away. The test then looks for a
   * confirmation on a freshly re-rendered empty form and times out — a failure that
   * reads like a rejected POST.
   *
   * React attaches its props to the DOM node under a `__react*` key when it hydrates,
   * so that key appearing is the boundary itself. An internal detail, but the only
   * honest signal: hydration changes nothing else observable.
   */
  const formIsInteractive = (page: Page) =>
    page.waitForFunction(() => {
      const form = document.querySelector('form')
      return !!form && Object.keys(form).some((key) => key.startsWith('__react'))
    })

  test('takes a visitor’s message and confirms it in Persian', async ({ page }) => {
    // The other half of the Wave 3 criterion: a client can build a contact form and
    // receive a submission. The confirmation only renders on a 2xx, so this failing
    // means the POST was rejected — which it was, before `beforeValidate` supplied
    // the site an anonymous request cannot know.
    await page.goto(`${acme}/about`)
    await formIsInteractive(page)

    await page.locator('#name').fill('حمید نوشادی')
    await page.locator('#email').fill('hamid@example.test')
    await page.locator('#message').fill('یک پیام آزمایشی از تست.')
    await page.getByRole('button', { name: 'ارسال پیام' }).click()

    // 30s, not the 5s default: this is the run's first POST to the API route, so the
    // dev server compiles it while the form sits on «در حال ارسال…».
    await expect(page.getByText('پیام شما رسید')).toBeVisible({ timeout: 30_000 })
  })

  test('names a missing field in Persian rather than failing silently', async ({ page }) => {
    await page.goto(`${acme}/about`)
    await formIsInteractive(page)

    await page.getByRole('button', { name: 'ارسال پیام' }).click()

    // Client-side, so nothing is posted — but the visitor has to be told *something*,
    // and an English validation message on a Persian form is a bug of its own.
    await expect(page.locator('form')).toContainText('این فیلد الزامی است')
  })
})

test.describe('live preview', () => {
  test('lets the admin origin frame a customer page, and names only it', async ({ page }) => {
    /**
     * Without this header the preview pane is blank with nothing but a console
     * message, and the failure reads as a broken URL rather than a policy.
     * `frame-ancestors` and not `X-Frame-Options` because the latter cannot name an
     * origin — only `SAMEORIGIN`, which a cross-domain preview is precisely not.
     * Naming the admin rather than allowing any parent is the point: a customer page
     * must not be frameable by a stranger.
     */
    const csp = (await page.goto(`${acme}/about`))?.headers()['content-security-policy']

    expect(csp).toBe("frame-ancestors 'self' http://localhost:3000")
  })

  test('refuses to turn on draft mode without the preview secret', async ({ page }) => {
    // The token in the URL is the editor's session; the secret is the second half.
    // Both are checked before `draftMode().enable()`, and a 403 here is what keeps
    // `/next/preview` from being an open draft reader.
    const res = await page.goto(`${acme}/next/preview?path=%2Fabout&previewSecret=wrong`)

    expect(res?.status()).toBe(403)
  })
})
