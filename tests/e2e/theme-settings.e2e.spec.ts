import { expect, test } from '@playwright/test'

import { login } from '../helpers/login'

test.describe('Tenant theme settings UI', () => {
  test('renders the theme settings document view for a site owner', async ({ page }) => {
    await login({ page, user: { email: 'acme@eshobe.test', password: 'test1234' } })

    const sitesRes = await page.request.get('http://localhost:3000/api/sites?limit=50&depth=0')
    const sites = (await sitesRes.json()) as { docs: { domain: string; id: string }[] }
    const acme = sites.docs.find((site) => site.domain === 'acme.localhost')
    expect(acme?.id).toBeTruthy()

    await page.goto(`http://localhost:3000/admin/collections/sites/${acme!.id}/theme-settings`)
    await expect(page.getByRole('heading', { name: /تنظیمات پوسته/ })).toBeVisible({
      timeout: 60_000,
    })
    await page.screenshot({
      fullPage: true,
      path: '/opt/cursor/artifacts/theme-settings-admin.png',
    })
  })
})
