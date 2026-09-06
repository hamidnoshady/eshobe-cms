// @vitest-environment node
import type { PostgresAdapter } from '@payloadcms/db-postgres'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { Client, Pool } from 'pg'
import { BasePayload } from 'payload'
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { runtimeDatabaseOptions, migrationDatabaseOptions } from '@/lib/database'
import {
  findPublicOwnershipViolations,
  normalizePublicOwnership,
  resolveRuntimeRole,
} from '@/lib/database-ownership'

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

/**
 * The srv1 incident, replayed against a real server: privileged migrations
 * create objects owned by the privileged role, on a database with NO grants
 * whose tables are already owned by the restricted runtime role. What must
 * come out of the one-shot step is pinned here so it cannot regress.
 */
describe.skipIf(!process.env.DATABASE_URL)('post-migration ownership normalisation', () => {
  const adminURL = process.env.DATABASE_URL
  const scratchDB = 'eshobe_ownership_test'
  const runtimeRole = 'eshobe_app'
  const runtimePassword = 'int-ownership-test-only'

  let admin: Pool
  let scratch: Pool
  let createdRole: boolean

  beforeAll(async () => {
    // CI and the local compose stack both expose the privileged superuser here.
    // The error listeners are the documented pg pattern for idle-client
    // terminations during teardown; without one, closing sockets can crash
    // the worker as an "uncaught" error after the suite already passed.
    admin = new Pool({ connectionString: adminURL })
    admin.on('error', () => undefined)
    const superuser = await admin.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    )
    expect(superuser.rows[0]?.rolsuper, 'this suite needs the privileged CI role').toBe(true)

    await admin.query(`DROP DATABASE IF EXISTS ${scratchDB} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${scratchDB}`)

    const existingRole = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      runtimeRole,
    ])
    createdRole = existingRole.rowCount === 0
    if (createdRole) {
      await admin.query(
        `CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
           NOREPLICATION NOBYPASSRLS PASSWORD '${runtimePassword}'`,
      )
    }

    const url = new URL(adminURL!)
    url.pathname = `/${scratchDB}`
    scratch = new Pool({ connectionString: url.toString() })
    scratch.on('error', () => undefined)

    // The production pre-state: runtime-owned tables (owner-only ACLs, no
    // grants, no default ACLs), enums still owned by the privileged role —
    // the original reason migrations run privileged — plus what a privileged
    // migration deploy leaves behind: everything below owned by `eshobe`.
    await scratch.query(`
        CREATE TYPE public.enum_channel_pre AS ENUM ('web');
        CREATE TABLE public.orders_pre (id uuid PRIMARY KEY, channel public.enum_channel_pre);
        CREATE SEQUENCE public.orders_pre_seq;
        ALTER TABLE public.orders_pre OWNER TO ${runtimeRole};
        ALTER SEQUENCE public.orders_pre_seq OWNER TO ${runtimeRole};

        CREATE TYPE public.enum_channel_new AS ENUM ('web');
        CREATE TYPE public.composite_new AS (a int);
        CREATE DOMAIN public.domain_new AS text;
        CREATE TABLE public.payments_new (
          id uuid PRIMARY KEY,
          channel public.enum_channel_new,
          tag public.domain_new,
          extra public.composite_new
        );
        CREATE SEQUENCE public.payments_new_seq;
        CREATE VIEW public.payments_new_view AS SELECT id FROM public.payments_new;
        CREATE MATERIALIZED VIEW public.payments_new_mv AS SELECT id FROM public.payments_new;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      `)
    expect(
      (
        await scratch.query('SELECT has_schema_privilege($1, $2, $3) AS ok', [
          runtimeRole,
          'public',
          'CREATE',
        ])
      ).rows[0].ok,
    ).toBe(false)
  })

  afterAll(async () => {
    await scratch?.end().catch(() => undefined)
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${scratchDB} WITH (FORCE)`).catch(() => undefined)
      if (createdRole) {
        await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => undefined)
      }
      await admin.end().catch(() => undefined)
    }
  })

  it('normalises every public object to the runtime role in one pass', async () => {
    const changes = await normalizePublicOwnership(scratch, runtimeRole)
    expect(changes).toEqual({ tables: 1, sequences: 1, views: 2, types: 4 })

    const owners = await scratch.query<{ kind: string; name: string; owner: string }>(`
        SELECT c.relkind AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'S', 'v', 'm', 'i')
        ORDER BY c.relname
      `)
    // Indexes and array/row types follow their table automatically; the
    // rehearsal counted 59 indexes that would otherwise stay privileged.
    expect(owners.rows.length).toBeGreaterThan(6)
    expect(owners.rows.filter((row) => row.owner !== runtimeRole)).toEqual([])

    const typeOwners = await scratch.query<{ name: string; owner: string }>(`
        SELECT t.typname AS name, pg_get_userbyid(t.typowner) AS owner
        FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class rc ON rc.oid = t.typrelid
        WHERE n.nspname = 'public' AND t.typisdefined
          AND (t.typtype IN ('e', 'd', 'r', 'm') OR rc.relkind = 'c')
        ORDER BY t.typname
      `)
    expect(typeOwners.rows.map((row) => row.name)).toEqual([
      'composite_new',
      'domain_new',
      'enum_channel_new',
      'enum_channel_pre',
    ])
    expect(typeOwners.rows.filter((row) => row.owner !== runtimeRole)).toEqual([])
  })

  it('keeps the owner-only model: no ACLs are written anywhere', async () => {
    const relations = await scratch.query<{ relacl: unknown }>(`
        SELECT c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'S', 'v', 'm')
      `)
    expect(relations.rows.every((row) => row.relacl === null)).toBe(true)
    const types = await scratch.query<{ typacl: unknown }>(`
        SELECT t.typacl FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class rc ON rc.oid = t.typrelid
        WHERE n.nspname = 'public' AND t.typisdefined
          AND (t.typtype IN ('e', 'd', 'r', 'm') OR rc.relkind = 'c')
      `)
    expect(types.rows.every((row) => row.typacl === null)).toBe(true)
  })

  it('passes the runtime accessibility gate, including the incident query itself', async () => {
    await expect(findPublicOwnershipViolations(scratch, runtimeRole)).resolves.toEqual([])
    // Exactly the query from the srv1 rehearsal; must be 0 for web to start.
    const inaccessible = await scratch.query<{ n: number }>(`
        SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public'
          AND NOT has_table_privilege('${runtimeRole}', schemaname || '.' || tablename, 'SELECT')
      `)
    expect(inaccessible.rows[0].n).toBe(0)
  })

  it('gives the runtime role back the ALTER TYPE rights that caused all this', async () => {
    const url = new URL(adminURL!)
    url.pathname = `/${scratchDB}`
    url.username = runtimeRole
    url.password = runtimePassword
    const app = new Client({ connectionString: url.toString() })
    await app.connect()
    try {
      await app.query("ALTER TYPE public.enum_channel_new ADD VALUE 'added_by_runtime'")
      await app.query('SELECT count(*) FROM public.payments_new')
      await app.query(
        "INSERT INTO public.orders_pre (id, channel) VALUES (gen_random_uuid(), 'web')",
      )
      await app.query("SELECT nextval('public.payments_new_seq')")
    } finally {
      await app.end()
    }
  })

  it('is idempotent: re-running with nothing changed issues no DDL', async () => {
    await expect(normalizePublicOwnership(scratch, runtimeRole)).resolves.toEqual({
      tables: 0,
      sequences: 0,
      views: 0,
      types: 0,
    })
    await expect(findPublicOwnershipViolations(scratch, runtimeRole)).resolves.toEqual([])
  })

  it('fails the gate on drift the normaliser has not covered yet', async () => {
    await scratch.query('CREATE TABLE public.stray_table (id int)')
    const violations = await findPublicOwnershipViolations(scratch, runtimeRole)
    expect(violations.some((v) => v.name === 'public.stray_table')).toBe(true)
    expect(
      violations.some((v) => v.name === 'public.stray_table' && /owned by/.test(v.problem)),
    ).toBe(true)
    // And the normaliser repairs it:
    await expect(normalizePublicOwnership(scratch, runtimeRole)).resolves.toMatchObject({
      tables: 1,
    })
    await expect(findPublicOwnershipViolations(scratch, runtimeRole)).resolves.toEqual([])
  })

  it('refuses an unknown role instead of guessing or half-running', async () => {
    await expect(normalizePublicOwnership(scratch, 'eshobe_no_such_role')).rejects.toThrow(
      'Runtime database role "eshobe_no_such_role" does not exist',
    )
    await expect(findPublicOwnershipViolations(scratch, 'eshobe_no_such_role')).rejects.toThrow(
      'does not exist',
    )
  })
})
