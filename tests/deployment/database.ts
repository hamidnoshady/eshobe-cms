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
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE eshobe_migration_test TO eshobe_app;
      GRANT USAGE ON SCHEMA public TO eshobe_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eshobe_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eshobe_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE eshobe IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eshobe_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE eshobe IN SCHEMA public
        GRANT USAGE, SELECT ON SEQUENCES TO eshobe_app;
    `)
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
  } else if (command === 'assert-current') {
    const applied = await pool.query('SELECT name FROM payload_migrations ORDER BY name')
    assert.deepEqual(
      applied.rows.map((row) => row.name),
      migrations.map((m) => m.name),
    )
    const types = await pool.query(`
      SELECT typname, pg_get_userbyid(typowner) AS owner FROM pg_type
      WHERE typname IN ('enum_orders_payment_provider', 'enum_store_payment_provider',
                        'enum_payment_gateways_gateway') ORDER BY typname
    `)
    assert.equal(types.rowCount, 3)
    assert(types.rows.every((row) => row.owner === 'eshobe'))
    const appRole = await pool.query(`
      SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'eshobe_app'
    `)
    assert.deepEqual(appRole.rows, [{ rolsuper: false, rolcreatedb: false, rolcreaterole: false }])
    const tables = ['payment_gateways', 'sites_domains', 'cdn_zones', 'reseller_domains']
    for (const table of tables) {
      const grants = await pool.query(
        "SELECT has_table_privilege('eshobe_app', $1, 'SELECT') AS allowed",
        [table],
      )
      assert.equal(grants.rows[0].allowed, true)
    }
  } else {
    throw new Error('Expected prepare, assert-baseline or assert-current')
  }
  console.log(`Migration smoke test: ${command} OK`)
} finally {
  await payload.destroy()
}
