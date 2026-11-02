import { defineConfig, devices } from '@playwright/test'

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import 'dotenv/config'

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests/e2e',
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /**
   * Playwright's default per-test timeout is 30s, which is shorter than the
   * explicit 30–60s waits this suite needs for a cold Next/Payload dev route.
   * The test used to be killed at 30s while its own `expect(..., {timeout:
   * 30_000})` was still waiting — a false "element not found" on CI. Passing
   * tests finish at the same speed; only slow ones get room to settle.
   */
  timeout: 120_000,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    // baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    env: {
      /**
       * The e2e fixture user is a platform admin (`tests/helpers/seedUser.ts`), but
       * most of `admin.e2e.spec.ts` is about the *editing* experience — the page
       * editor, live preview, the Shamsi date hint. `src/admin/visibility.ts` hides
       * the content collections from an operator's nav by default, which would 404
       * every one of those routes.
       *
       * So the suite runs with the escape hatch on, and the split itself is asserted
       * with it off, in `tests/e2e/superadmin.e2e.spec.ts`, by a second user.
       */
      PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS: 'true',
    },
    // A reused `pnpm dev` started without PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS makes
    // `admin.e2e.spec.ts` navigate to hidden collections and time out (see gotchas).
    reuseExistingServer: !process.env.CI,
    // A cold Next 16 + Payload dev boot compiles `/admin` on demand and blows
    // straight through Playwright's 60s default.
    timeout: 180_000,
    // `/admin`, not `/`: plain `localhost` belongs to no site and 404s by design, and
    // Playwright's readiness check does not accept a 404.
    url: 'http://localhost:3000/admin/login',
  },
})
