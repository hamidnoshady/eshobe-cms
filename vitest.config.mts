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
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/int/**/*.int.spec.ts'],
  },
})
