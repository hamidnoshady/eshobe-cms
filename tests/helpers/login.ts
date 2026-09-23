import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export interface LoginOptions {
  page: Page
  serverURL?: string
  user: {
    email: string
    password: string
  }
}

/**
 * Logs the user into the admin panel via the login page.
 */
export async function login({
  page,
  serverURL = 'http://localhost:3000',
  user,
}: LoginOptions): Promise<void> {
  await page.goto(`${serverURL}/admin/login`)

  await page.fill('#field-email', user.email)
  await page.fill('#field-password', user.password)
  await page.click('button[type="submit"]')

  await page.waitForURL(new RegExp(`^${serverURL}/admin(\\?|$)`), { timeout: 60_000 })

  // Verify that login succeeded and the admin interface is visible.
  await expect(
    page.locator('.nav, .dashboard, header, h1, h2, span[title="داشبورد"]').first(),
  ).toBeVisible({ timeout: 30_000 })
}
