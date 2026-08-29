import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    /**
     * Vitest's default is 10s, and `getPayload()` in a `beforeAll` exceeds it on a
     * cold Postgres connection — it pulls the schema before the first query. Left at
     * the default it passes on an idle machine and fails whenever the dev server or
     * a sibling spec file is competing for connections, which reads as a flake.
     */
    hookTimeout: 120_000,
    /**
     * Same reason, in a test body rather than a hook: the provisioning rollback spec
     * writes a whole site (theme, form, four pages × two locales, nav) before its
     * simulated failure, which does not fit Vitest's 5s default. When it times out
     * mid-transaction the rollback never completes, so the half-provisioned site
     * survives into `tenancy.int.spec.ts` and fails *its* page count too — one
     * timeout reads as two unrelated failures.
     */
    testTimeout: 60_000,
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
  },
})
