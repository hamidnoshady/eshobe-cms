import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { getPayload } from 'payload'

import config from '../../src/payload.config'
import { responsiveFontSizeCss } from '../../src/lib/deploy/theme-settings'
import { login } from '../helpers/login'

/**
 * The theme-settings surfaces (#209–#212).
 *
 * The second test builds a temporary deployable theme for `acme.localhost` through the
 * admin API, so the categorized renderer is exercised against a manifest with enough
 * settings to have been a wall of inputs before. It deletes its own fixtures.
 */

const ADMIN = 'http://localhost:3000'

const acmeSite = async (page: Page) => {
  const res = await page.request.get(`${ADMIN}/api/sites?limit=50&depth=0`)
  const sites = (await res.json()) as { docs: { domain: string; id: string }[] }
  const acme = sites.docs.find((site) => site.domain === 'acme.localhost')
  expect(acme?.id).toBeTruthy()
  return acme!
}

/**
 * A theme package's `manifest` is platform-read-only by field access (only a manifest
 * sync writes it, with `overrideAccess`), so a REST create would silently drop it.
 * The fixture is created through the Local API exactly like the integration suite.
 */
const createThemePackage = async (key: string) => {
  const payload = await getPayload({ config: await config })
  const doc = await payload.create({
    collection: 'theme-packages',
    data: {
      contractVersion: 1,
      defaultRef: 'main',
      envSchema: [],
      key,
      manifest: designManifest,
      name: 'پوستهٔ آزمون',
      provider: 'github',
      repository: 'hamidnoshady/e2e-settings-theme',
      status: 'published',
      visibility: 'public',
    },
    overrideAccess: true,
  })
  return { id: String(doc.id), payload }
}

const designManifest = {
  build: { pack: 'nixpacks', port: 3000 },
  contractVersion: 1,
  key: 'e2e-settings-theme',
  name: 'E2E settings theme',
  preview: 'https://example.com/',
  settings: {
    bodySize: {
      category: 'typography',
      default: { desktop: 18, mobile: 15, tablet: 16 },
      group: 'design',
      labelFa: 'اندازهٔ متن اصلی',
      locales: ['fa', 'en'],
      max: 40,
      min: 12,
      section: 'body',
      step: 1,
      type: 'responsiveFontSize',
    },
    headerGap: { category: 'layout', group: 'design', labelFa: 'فاصلهٔ سربرگ', type: 'number' },
    heroTitle: {
      category: 'typography',
      default: { desktop: 44, mobile: 28, tablet: 34 },
      group: 'design',
      labelFa: 'اندازهٔ عنوان قهرمان',
      max: 80,
      min: 14,
      section: 'headings',
      step: 1,
      type: 'responsiveFontSize',
    },
    introMotion: { category: 'motion', default: true, group: 'design', labelFa: 'حرکت ورود', type: 'boolean' },
    menuStyle: {
      category: 'navigation',
      group: 'design',
      labelFa: 'سبک منو',
      options: [{ labelFa: 'ساده', value: 'plain' }, { labelFa: 'برجسته', value: 'bold' }],
      type: 'select',
    },
    primaryColor: { category: 'colors', group: 'design', labelFa: 'رنگ اصلی', type: 'text' },
  },
  siteTypes: ['business', 'portfolio', 'store'],
}

test.describe('Tenant theme settings UI', () => {
  test('renders the theme settings document view for a site owner', async ({ page }) => {
    await login({ page, user: { email: 'acme@eshobe.test', password: 'test1234' } })

    const acme = await acmeSite(page)
    await page.goto(`${ADMIN}/admin/collections/sites/${acme.id}/theme-settings`)
    await expect(page.getByRole('heading', { name: /تنظیمات پوسته/ })).toBeVisible({
      timeout: 60_000,
    })
  })

  test('groups a manifest into categories, keeps device edits, and saves px', async ({ page }) => {
    page.setDefaultTimeout(60_000)
    await login({ page, user: { email: 'admin@eshobe.test', password: 'test1234' } })

    const acme = await acmeSite(page)
    const siteRes = await page.request.get(`${ADMIN}/api/sites/${acme.id}?depth=0`)
    const originalSite = (await siteRes.json()) as {
      assignedThemePackage?: null | string | { id: string }
    }
    const originalAssigned =
      typeof originalSite.assignedThemePackage === 'string'
        ? originalSite.assignedThemePackage
        : (originalSite.assignedThemePackage?.id ?? null)
    const suffix = Date.now()
    const { id: packageId, payload } = await createThemePackage(`e2e-settings-${suffix}`)
    await page.request.patch(`${ADMIN}/api/sites/${acme.id}`, {
      data: { assignedThemePackage: packageId },
    })

    try {
      const themeRes = await page.request.get(
        `${ADMIN}/api/theme?depth=0&limit=1&where[site][equals]=${acme.id}`,
      )
      const theme = (await themeRes.json()) as { docs: { id: string }[] }
      const themeId = theme.docs[0]?.id
      expect(themeId).toBeTruthy()

      await page.goto(`${ADMIN}/admin/collections/theme/${themeId}`)
      await expect(page.getByRole('heading', { name: 'گزینه‌های طراحی پوسته' })).toBeVisible({
        timeout: 60_000,
      })

      // Categories, not one unbounded stack.
      const nav = page.locator('.theme-runtime__nav')
      await expect(nav.getByRole('tab', { name: /تایپوگرافی/ })).toBeVisible()
      await expect(nav.getByRole('tab', { name: /رنگ‌ها/ })).toBeVisible()
      await expect(nav.getByRole('tab', { name: /چیدمان/ })).toBeVisible()

      const role = page.locator('.theme-typography').first()
      await expect(role).toBeVisible()
      await expect(role.locator('input[type="number"]')).toHaveCount(3)
      await expect(role.locator('.theme-number__unit').first()).toHaveText('px')

      // Switch device, type, switch away and back: the working value survives.
      const desktop = role.locator('input[type="number"]').nth(0)
      await desktop.fill('38')
      await role.getByRole('button', { name: /تبلت/ }).click()
      await expect(role.locator('input[type="number"]').nth(1)).toHaveValue('')
      await role.getByRole('button', { name: /دسکتاپ/ }).click()
      await expect(role.locator('input[type="number"]').nth(0)).toHaveValue('38')

      // Language tab appears because the manifest declares fa+en and the site serves them.
      await expect(role.getByRole('button', { name: /فارسی/ })).toBeVisible()

      // Search narrows the list to the matching role.
      await page.getByLabel('جست‌وجو در گزینه‌ها').fill('عنوان قهرمان')
      await expect(page.locator('.theme-typography')).toHaveCount(1)

      // Reset is a confirmed, scoped action.
      await page.getByRole('button', { name: 'بازگرداندن پیش‌فرض‌های پوسته' }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.getByRole('button', { name: 'انصراف' }).click()
      await expect(page.getByRole('alertdialog')).toHaveCount(0)

      // The saved-build preview is present and explicitly not the unsaved draft.
      await expect(page.getByRole('heading', { name: 'پیش‌نمایش سایت' })).toBeVisible()
      await expect(page.locator('iframe.theme-preview__frame')).toHaveAttribute(
        'src',
        'https://example.com/',
      )
      await expect(page.getByText('نسخهٔ ذخیره‌شده و مستقرشده')).toBeVisible()

      // Nothing has been sent yet.
      const before = await page.request.get(
        `${ADMIN}/api/site-theme-settings/current?site=${acme.id}`,
      )
      expect(((await before.json()) as { runtimeSettings: Record<string, unknown> }).runtimeSettings.bodySize)
        .toBeUndefined()

      await page.getByRole('button', { name: 'ذخیرهٔ گزینه‌های طراحی پوسته' }).click()
      await expect(page.getByText('ذخیره شد.')).toBeVisible({ timeout: 30_000 })

      const after = await page.request.get(
        `${ADMIN}/api/site-theme-settings/current?site=${acme.id}`,
      )
      const saved = (await after.json()) as { runtimeSettings: Record<string, unknown> }
      expect(saved.runtimeSettings.bodySize).toEqual({ desktop: 38 })

      // Reload and confirm the value comes back from the server.
      await page.reload()
      const reloaded = page.locator('.theme-typography').first()
      await expect(reloaded.locator('input[type="number"]').nth(0)).toHaveValue('38')

      // The admin form stays inside the viewport at phone/tablet/desktop widths.
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ height: 900, width })
        const overflow = await page.evaluate(() => {
          const form = document.querySelector('.theme-form')
          if (!form) return Number.MAX_SAFE_INTEGER
          return form.scrollWidth - form.clientWidth
        })
        expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1)
      }
    } finally {
      await page.request.patch(`${ADMIN}/api/sites/${acme.id}`, {
        data: { assignedThemePackage: originalAssigned },
      })
      // The settings row references the package with ON DELETE SET NULL and a NOT NULL
      // column, so it has to go first.
      const settingRows = await page.request.get(
        `${ADMIN}/api/site-theme-settings?depth=0&limit=5&where[site][equals]=${acme.id}`,
      )
      if (settingRows.ok()) {
        const rows = (await settingRows.json()) as { docs: { id: string }[] }
        for (const row of rows.docs) {
          await page.request.delete(`${ADMIN}/api/site-theme-settings/${row.id}`)
        }
      }
      await payload.delete({
        collection: 'theme-packages',
        id: packageId,
        overrideAccess: true,
      })
    }
  })
})

/**
 * The verification matrix the three P0/P1 issues ask for: both admin languages, both
 * admin themes, keyboard operation, an axe scan of the settings form, and a real CSS
 * measurement of the resolved typography at the documented breakpoints.
 */
test.describe('Theme settings verification matrix', () => {
  test('is usable in fa/en and light/dark, by keyboard, with no serious axe findings', async ({
    context,
    page,
  }) => {
    test.setTimeout(300_000)
    page.setDefaultTimeout(60_000)
    await login({ page, user: { email: 'admin@eshobe.test', password: 'test1234' } })

    const acme = await acmeSite(page)
    const siteRes = await page.request.get(`${ADMIN}/api/sites/${acme.id}?depth=0`)
    const originalSite = (await siteRes.json()) as {
      assignedThemePackage?: null | string | { id: string }
    }
    const originalAssigned =
      typeof originalSite.assignedThemePackage === 'string'
        ? originalSite.assignedThemePackage
        : (originalSite.assignedThemePackage?.id ?? null)
    const { id: packageId, payload } = await createThemePackage(`e2e-matrix-${Date.now()}`)
    await page.request.patch(`${ADMIN}/api/sites/${acme.id}`, {
      data: { assignedThemePackage: packageId },
    })

    const labels = {
      en: {
        cancel: 'Cancel',
        desktop: 'Desktop',
        heading: 'Theme design options',
        reset: 'Restore theme defaults',
        search: 'Search settings',
        typography: 'Typography',
      },
      fa: {
        cancel: 'انصراف',
        desktop: 'دسکتاپ',
        heading: 'گزینه‌های طراحی پوسته',
        reset: 'بازگرداندن پیش‌فرض‌های پوسته',
        search: 'جست‌وجو در گزینه‌ها',
        typography: 'تایپوگرافی',
      },
    } as const

    try {
      const themeRes = await page.request.get(
        `${ADMIN}/api/theme?depth=0&limit=1&where[site][equals]=${acme.id}`,
      )
      const themeId = ((await themeRes.json()) as { docs: { id: string }[] }).docs[0]?.id
      expect(themeId).toBeTruthy()

      let saved = false
      for (const locale of ['fa', 'en'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          await context.addCookies([
            { name: 'payload-lng', url: ADMIN, value: locale },
            // Payload's admin theme is a cookie, not localStorage (unlike the site theme).
            { name: 'payload-theme', url: ADMIN, value: theme },
          ])
          await page.goto(`${ADMIN}/admin/collections/theme/${themeId}`)

          await expect(page.locator('html')).toHaveAttribute('lang', locale)
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
          await expect(page.getByRole('heading', { name: labels[locale].heading })).toBeVisible({
            timeout: 60_000,
          })

          const nav = page.locator('.theme-runtime__nav')
          const tab = nav.getByRole('tab', { name: new RegExp(labels[locale].typography) })
          await expect(tab).toBeVisible()

          // Keyboard: reach the category tab and activate it.
          await tab.focus()
          await page.keyboard.press('Enter')
          await expect(tab).toHaveAttribute('aria-selected', 'true')

          const role = page.locator('.theme-typography').first()
          await expect(role).toBeVisible()
          const sample = role.locator('.theme-typography__sample-text')
          if (!saved) {
            await role.locator('input[type="number"]').first().fill('38')
            await expect(sample).toHaveCSS('font-size', '38px')
            await page.getByRole('button', { name: /ذخیرهٔ گزینه‌های طراحی پوسته|Save theme design options/ }).click()
            await expect(page.getByText('ذخیره شد.')).toBeVisible({ timeout: 30_000 })
            saved = true
            await page.reload()
          }
          await expect(role.locator('input[type="number"]').first()).toHaveValue('38')
          await expect(sample).toHaveCSS('font-size', '38px')

          // Scoped reset opens by keyboard and cancels by keyboard.
          const reset = page.getByRole('button', { name: labels[locale].reset })
          await reset.focus()
          await page.keyboard.press('Enter')
          await expect(page.getByRole('alertdialog')).toBeVisible()
          const cancel = page.getByRole('button', { name: labels[locale].cancel })
          await cancel.focus()
          await page.keyboard.press('Enter')
          await expect(page.getByRole('alertdialog')).toHaveCount(0)

          // Accessibility: the form itself, not the admin chrome, in this theme/locale.
          const axe = await new AxeBuilder({ page })
            .include('.theme-form')
            .disableRules(['frame-tested'])
            .analyze()
          const serious = axe.violations.filter(
            (violation) => violation.impact === 'serious' || violation.impact === 'critical',
          )
          expect(
            serious.map((violation) => ({
              id: violation.id,
              nodes: violation.nodes.map((node) => ({
                failure: node.failureSummary?.slice(0, 160),
                target: node.target,
              })),
            })),
            `${locale}/${theme}`,
          ).toEqual([])

          // No horizontal overflow of the form at phone/tablet/desktop widths.
          for (const width of [375, 768, 1440]) {
            await page.setViewportSize({ height: 900, width })
            const overflow = await page.evaluate(() => {
              const form = document.querySelector('.theme-form')
              if (!form) return Number.MAX_SAFE_INTEGER
              return form.scrollWidth - form.clientWidth
            })
            expect(overflow, `${locale}/${theme} overflow at ${width}px`).toBeLessThanOrEqual(1)
          }
          await page.setViewportSize({ height: 900, width: 1440 })

          // Keyboard: a section collapses/expands with Space (done last, because a
          // collapsed section removes its fields from the DOM).
          const sectionToggle = page.locator('.theme-section__toggle').first()
          await sectionToggle.focus()
          const before = await sectionToggle.getAttribute('aria-expanded')
          await page.keyboard.press('Space')
          await expect(sectionToggle).toHaveAttribute(
            'aria-expanded',
            before === 'true' ? 'false' : 'true',
          )
        }
      }
    } finally {
      await page.request.patch(`${ADMIN}/api/sites/${acme.id}`, {
        data: { assignedThemePackage: originalAssigned },
      })
      const settingRows = await page.request.get(
        `${ADMIN}/api/site-theme-settings?depth=0&limit=5&where[site][equals]=${acme.id}`,
      )
      if (settingRows.ok()) {
        const rows = (await settingRows.json()) as { docs: { id: string }[] }
        for (const row of rows.docs) {
          await page.request.delete(`${ADMIN}/api/site-theme-settings/${row.id}`)
        }
      }
      await payload.delete({
        collection: 'theme-packages',
        id: packageId,
        overrideAccess: true,
      })
    }
  })

  test('resolved typography matches computed CSS at 375/768/1440 in RTL and LTR', async ({
    page,
  }) => {
    const spec = {
      default: { desktop: 42, mobile: 28, tablet: 34 },
      locales: ['fa' as const, 'en' as const],
      max: 80,
      min: 14,
      step: 1,
      unit: 'px' as const,
    }

    const cases = [
      {
        dir: 'rtl',
        expected: { desktop: 38, mobile: 38, tablet: 38 },
        label: 'fa saved',
        lang: 'fa',
        value: { desktop: 38 },
      },
      {
        dir: 'ltr',
        expected: { desktop: 32, mobile: 20, tablet: 20 },
        label: 'en unsaved',
        lang: 'en',
        value: { desktop: 32, tablet: 20 },
      },
      {
        dir: 'rtl',
        expected: { desktop: 38, mobile: 12, tablet: 38 },
        label: 'fa locale override',
        lang: 'fa',
        value: { desktop: 38, locales: { fa: { mobile: 12 } } },
      },
    ]

    for (const entry of cases) {
      const css = responsiveFontSizeCss(spec, entry.value, { selector: '.semantic-role' })
      await page.setContent(
        `<!doctype html><html lang="${entry.lang}" dir="${entry.dir}"><head><style>${css}</style></head><body><p class="semantic-role">نمونه Sample</p></body></html>`,
      )
      for (const [device, width] of [
        ['desktop', 1440],
        ['tablet', 768],
        ['mobile', 375],
      ] as const) {
        await page.setViewportSize({ height: 800, width })
        const computed = await page
          .locator('.semantic-role')
          .evaluate((element) => getComputedStyle(element).fontSize)
        expect(computed, `${entry.label} at ${width}px`).toBe(`${entry.expected[device]}px`)
      }
    }
  })
})
