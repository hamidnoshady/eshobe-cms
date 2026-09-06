// @vitest-environment node
// The DB-backed replay of the srv1 ownership incident (normalisation, gate,
// idempotence, fail-closed drift detection) lives in tests/deployment/ownership.ts
// and runs as its own CI step: it needs its own throwaway database and roles,
// and adding it to this parallel spec pool perturbs which files share workers
// — the int suites share one seeded database and are sensitive to that.
import type { PostgresAdapter } from '@payloadcms/db-postgres'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { BasePayload } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runtimeDatabaseOptions, migrationDatabaseOptions } from '@/lib/database'
import { resolveRuntimeRole } from '@/lib/database-ownership'

const runtimeURL = 'postgres://eshobe_app:runtime-test-only@127.0.0.1:1/eshobe'
const migrateURL = 'postgres://eshobe:migration-test-only@127.0.0.1:1/eshobe'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('separate runtime and migration connections', () => {
  it('uses only DATABASE_URL in the runtime, even when both URLs are present', () => {
    const options = runtimeDatabaseOptions({
      DATABASE_URL: runtimeURL,
      MIGRATE_DATABASE_URL: migrateURL,
    })
    expect(options.pool.connectionString).toBe(runtimeURL)
    expect(options.prodMigrations).toBeUndefined()
    expect(options.push).toBeUndefined()
    expect(options.idType).toBe('uuid')
    expect(runtimeDatabaseOptions({ MIGRATE_DATABASE_URL: migrateURL }).pool.connectionString).toBe(
      undefined,
    )
  })

  it('uses only MIGRATE_DATABASE_URL in the migrator, with push and DB creation disabled', () => {
    const options = migrationDatabaseOptions({
      DATABASE_URL: runtimeURL,
      MIGRATE_DATABASE_URL: migrateURL,
    })
    expect(options.pool.connectionString).toBe(migrateURL)
    expect(options.prodMigrations).toBeUndefined()
    expect(options.push).toBe(false)
    expect(options.disableCreateDatabase).toBe(true)
    expect(options.idType).toBe(runtimeDatabaseOptions().idType)
  })

  it.each([undefined, '', '   '])('never falls back to DATABASE_URL for %j', (missing) => {
    expect(() =>
      migrationDatabaseOptions({ DATABASE_URL: runtimeURL, MIGRATE_DATABASE_URL: missing }),
    ).toThrow('MIGRATE_DATABASE_URL is required')
  })

  it.each([
    'not-a-url-with-migration-test-only',
    'https://eshobe:migration-test-only@db/eshobe',
    'postgres://db/eshobe',
    'postgres://eshobe:migration-test-only@db/',
  ])('rejects malformed/incomplete URLs without leaking the value', (url) => {
    let error: unknown
    try {
      migrationDatabaseOptions({ MIGRATE_DATABASE_URL: url })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('MIGRATE_DATABASE_URL')
    expect(String(error)).not.toContain(url)
    expect(String(error)).not.toContain('migration-test-only')
  })

  it.each(['development', 'production'])(
    'the actual %s app adapter has no boot migrations and retains default push behaviour',
    async (mode) => {
      vi.resetModules()
      vi.stubEnv('NODE_ENV', mode)
      vi.stubEnv('DATABASE_URL', runtimeURL)
      vi.stubEnv('MIGRATE_DATABASE_URL', migrateURL)
      vi.stubEnv('PAYLOAD_SECRET', 'migration-config-test-only-secret')
      vi.stubEnv('NEXT_PUBLIC_SERVER_URL', 'https://admin.example.com')
      const config = await (await import('@/payload.config')).default
      // Constructing an adapter does not connect, push or run migrations.
      const adapter = config.db.init({ payload: new BasePayload() }) as PostgresAdapter
      expect(adapter.poolOptions.connectionString).toBe(runtimeURL)
      expect(adapter.prodMigrations).toBeUndefined()
      expect(adapter.push).toBeUndefined()
    },
  )
})

describe('one-shot entrypoint fails closed', () => {
  const run = (overrides: Record<string, string>) =>
    spawnSync(process.execPath, ['node_modules/payload/bin.js', 'run', 'scripts/migrate.ts'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATABASE_URL: runtimeURL,
        // An empty value also prevents a developer's .env from filling it in.
        MIGRATE_DATABASE_URL: '',
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 30_000,
    })

  it('exits non-zero without a migration URL, even with a runtime URL', () => {
    const result = run({})
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MIGRATE_DATABASE_URL is required')
    expect(result.stderr).not.toContain(runtimeURL)
  })

  it('does not expose an invalid privileged URL in the error', () => {
    const result = run({ MIGRATE_DATABASE_URL: 'invalid-migration-test-only' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MIGRATE_DATABASE_URL must be a valid')
    expect(result.stderr).not.toContain('invalid-migration-test-only')
  })

  it('refuses Payload’s destructive drop switch before connecting', () => {
    const result = run({ MIGRATE_DATABASE_URL: migrateURL, PAYLOAD_DROP_DATABASE: 'true' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Refusing to migrate with PAYLOAD_DROP_DATABASE=true')
  })

  it('exits non-zero when the runtime role cannot be determined', () => {
    // A plain object with the two role sources stripped, cast for spawnSync:
    // this repo's ProcessEnv augmentation makes DATABASE_URL a required key.
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            !['DATABASE_URL', 'APP_DATABASE_ROLE'].includes(entry[0]) && entry[1] !== undefined,
        ),
      ),
      NODE_ENV: 'production',
      MIGRATE_DATABASE_URL: migrateURL,
    } as unknown as NodeJS.ProcessEnv
    const result = spawnSync(
      process.execPath,
      ['node_modules/payload/bin.js', 'run', 'scripts/migrate.ts'],
      { cwd: path.resolve(import.meta.dirname, '../..'), env, encoding: 'utf8', timeout: 30_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Cannot determine the runtime database role')
    expect(result.stderr).not.toContain('runtime-test-only')
  })
})

describe('runtime role resolution', () => {
  it('prefers an explicit APP_DATABASE_ROLE (trimmed) over DATABASE_URL', () => {
    expect(
      resolveRuntimeRole({ APP_DATABASE_ROLE: '  eshobe_app  ', DATABASE_URL: runtimeURL }),
    ).toBe('eshobe_app')
  })

  it('derives the role from the DATABASE_URL username when no explicit role is set', () => {
    expect(resolveRuntimeRole({ DATABASE_URL: runtimeURL })).toBe('eshobe_app')
    expect(
      resolveRuntimeRole({ DATABASE_URL: 'postgresql://runtime%40role:pw@db:5432/eshobe' }),
    ).toBe('runtime@role')
  })

  it.each([undefined, '', '   ', 'postgres://db/eshobe', 'https://user:pw@db/eshobe'])(
    'refuses to guess a role name for APP_DATABASE_ROLE/DATABASE_URL = %j',
    (databaseURL) => {
      expect(() => resolveRuntimeRole({ DATABASE_URL: databaseURL })).toThrow(
        'Cannot determine the runtime database role',
      )
    },
  )

  it('never echoes the connection URL or its credentials in the refusal', () => {
    // A malformed URL and a URL with no username are the two refusal paths
    // that can carry a credential; neither may surface in the message.
    for (const databaseURL of [
      'not a url://super-secret-pw',
      'postgres://:super-secret-pw@db:5432/eshobe',
    ]) {
      let error: unknown
      try {
        resolveRuntimeRole({ DATABASE_URL: databaseURL })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain('Cannot determine the runtime database role')
      expect(String(error)).not.toContain('super-secret-pw')
    }
  })
})
