// Invoked by compose-smoke.sh through Payload's TS loader; never part of the image.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { BasePayload, readMigrationFiles } from 'payload'

import configPromise from '../../src/payload.config'
import { migrationDatabaseOptions } from '../../src/lib/database'

const options = migrationDatabaseOptions()
const url = new URL(options.pool.connectionString!)
// This fixture creates a role and schema. Do not let it touch a production DB.
assert.equal(url.pathname, '/eshobe_migration_test', 'Use an isolated smoke-test database only')
assert.equal(url.username, 'eshobe')
assert.equal(process.env.NODE_ENV, 'production')
// srv1 passes the runtime role explicitly: DATABASE_URL must not reach migrate.
assert.equal(process.env.APP_DATABASE_ROLE, 'eshobe_app')

const config = await configPromise
const payload = new BasePayload()
try {
  await payload.init({
    config: {
      ...config,
      db: {
        ...config.db,
        init: postgresAdapter({
          ...options,
          migrationDir: fileURLToPath(new URL('../../src/migrations', import.meta.url)),
        }).init,
      },
    },
    disableOnInit: true,
    cron: false,
  })
  const pool = payload.db.pool
  const migrations = await readMigrationFiles({ payload })
  const command = process.argv[2]

  if (command === 'prepare') {
    const existing = await pool.query("SELECT to_regclass('public.payload_migrations') AS name")
    assert.equal(existing.rows[0].name, null, 'Fixture requires an empty database')
    const baseline = migrations.filter((m) => m.name < '20260905_003232_wave10_payment_gateways')
    assert.equal(baseline.length, 5)
    await payload.db.migrate({ migrations: baseline })

    const appURL = new URL(process.env.TEST_DATABASE_URL!)
    assert.equal(appURL.username, 'eshobe_app')
    assert.equal(appURL.pathname, url.pathname)
    const password = await pool.query('SELECT quote_literal($1) AS value', [
      decodeURIComponent(appURL.password),
    ])
    await pool.query(`
      CREATE ROLE eshobe_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
        PASSWORD ${password.rows[0].value};
      -- Reproduce the production database this model was built for: NO grants
      -- anywhere, tables/sequences already owned by the runtime role, and the
      -- ENUM TYPES still owned by the privileged role — the original reason
      -- migrations have to run privileged (ALTER TYPE ... ADD VALUE needs
      -- ownership). The runtime role must NOT be able to create in public.
      GRANT CONNECT ON DATABASE eshobe_migration_test TO eshobe_app;
      GRANT USAGE ON SCHEMA public TO eshobe_app;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        LOOP
          EXECUTE format('ALTER TABLE public.%I OWNER TO eshobe_app', r.relname);
        END LOOP;
      END $$;
    `)
    assert.equal(
      (await pool.query("SELECT has_schema_privilege('eshobe_app','public','CREATE') AS ok"))
        .rows[0].ok,
      false,
      'Fixture expects a locked-down public schema',
    )
    const appPool = new payload.db.pg!.Pool({ connectionString: appURL.toString() })
    try {
      await assert.rejects(
        appPool.query("ALTER TYPE public.enum_orders_payment_provider ADD VALUE 'not_allowed'"),
        /must be owner of type enum_orders_payment_provider/,
      )
    } finally {
      await appPool.end()
    }
  } else if (command === 'assert-baseline') {
    const applied = await pool.query('SELECT name FROM payload_migrations ORDER BY name')
    assert.equal(applied.rowCount, 5, 'A failed migration must not advance the migration ledger')
    const labels = await pool.query(
      'SELECT unnest(enum_range(NULL::enum_orders_payment_provider))::text AS value',
    )
    assert.deepEqual(
      labels.rows.map((row) => row.value),
      ['bank', 'http'],
    )
    const created = await pool.query("SELECT to_regclass('public.payment_gateways') AS name")
    assert.equal(created.rows[0].name, null, 'Failed wave10 DDL must be rolled back')
    // A failed one-shot must fail CLOSED: no normalisation, no new objects, and
    // the baseline ownership state (tables = eshobe_app, enums = eshobe) intact.
    const strayTables = await pool.query(`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND pg_get_userbyid(c.relowner) <> 'eshobe_app'
    `)
    assert.deepEqual(
      strayTables.rows.map((row) => row.relname),
      [],
      'A failed migrate must leave every public table owned by the runtime role',
    )
  } else if (command === 'assert-current') {
    const applied = await pool.query('SELECT name FROM payload_migrations ORDER BY name')
    assert.deepEqual(
      applied.rows.map((row) => row.name),
      migrations.map((m) => m.name),
    )

    // THE invariant this whole model exists for: after the one-shot, everything
    // in schema public — relations AND types (including the pre-existing enums
    // the migrator did not create itself) — is owned by the runtime role, with
    // owner-only ACLs. No GRANT model may be adopted in parallel.
    const relations = await pool.query(`
      SELECT DISTINCT c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner, c.relacl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'S', 'v', 'm')
      ORDER BY 1
    `)
    assert.equal(relations.rows.length > 0, true, 'Expected migrated relations in public')
    for (const row of relations.rows) {
      assert.equal(row.owner, 'eshobe_app', `relation kind ${row.kind} must be runtime-owned`)
      assert.equal(row.relacl, null, `relation kind ${row.kind} must keep owner-only ACLs`)
    }
    const types = await pool.query(`
      SELECT DISTINCT pg_get_userbyid(t.typowner) AS owner, t.typacl
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class rc ON rc.oid = t.typrelid
      WHERE n.nspname = 'public' AND t.typisdefined
        AND (t.typtype IN ('e', 'd', 'r', 'm') OR rc.relkind = 'c')
    `)
    assert.equal(types.rows.length > 0, true, 'Expected migrated types in public')
    for (const row of types.rows) {
      assert.equal(row.owner, 'eshobe_app', 'every public type must be runtime-owned')
      assert.equal(row.typacl, null, 'every public type must keep owner-only ACLs')
    }

    // The gate the migrate step runs before web may start: 0 inaccessible
    // tables, sequences and types. This is the exact query shape from the
    // srv1 incident rehearsal.
    const inaccessible = {
      tables: await pool.query(`
        SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public'
          AND NOT has_table_privilege('eshobe_app', schemaname || '.' || tablename, 'SELECT')
      `),
      sequences: await pool.query(`
        SELECT count(*)::int AS n FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
          AND NOT (has_sequence_privilege('eshobe_app', c.relname, 'USAGE')
               AND has_sequence_privilege('eshobe_app', c.relname, 'SELECT'))
      `),
      types: await pool.query(`
        SELECT count(*)::int AS n FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e'
          AND NOT has_type_privilege('eshobe_app', t.typname, 'USAGE')
      `),
    }
    assert.deepEqual(
      Object.fromEntries(Object.entries(inaccessible).map(([k, q]) => [k, q.rows[0].n])),
      { tables: 0, sequences: 0, types: 0 },
      'The runtime role must be able to use every object migrations created',
    )

    const appRole = await pool.query(`
      SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'eshobe_app'
    `)
    assert.deepEqual(appRole.rows, [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }])

    // Root cause removed: with the enums now runtime-owned, the restricted role
    // itself can ALTER TYPE again (the very operation that used to fail).
    // IF NOT EXISTS keeps this assert safe across the smoke's no-op re-run.
    const appPool = new payload.db.pg!.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
    try {
      await appPool.query(
        "ALTER TYPE public.enum_orders_payment_provider ADD VALUE IF NOT EXISTS 'ownership_smoke_ok'",
      )
      const read = await appPool.query('SELECT count(*)::int AS n FROM cdn_zones')
      assert.equal(read.rows[0].n, 0, 'Runtime role must read a table the migrator created')
    } finally {
      await appPool.end()
    }
  } else {
    throw new Error('Expected prepare, assert-baseline or assert-current')
  }
  console.log(`Migration smoke test: ${command} OK`)
} finally {
  await payload.destroy()
}
