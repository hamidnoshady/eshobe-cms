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
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
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
    reuseExistingServer: true,
    // A cold Next 16 + Payload dev boot compiles `/admin` on demand and blows
    // straight through Playwright's 60s default.
    timeout: 180_000,
    // `/admin`, not `/`: plain `localhost` belongs to no site and 404s by design, and
    // Playwright's readiness check does not accept a 404.
    url: 'http://localhost:3000/admin/login',
  },
})
