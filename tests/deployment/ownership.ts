// Standalone ownership replay — run with tsx, not inside the vitest pool:
// the int suite runs spec files in parallel against one seeded database, and
// destructive suites (tenancy/provisioning) can collide with read suites when
// the file schedule shifts. This replay uses its own throwaway database and
// roles, so it must not perturb that schedule (and vice versa).
//
//   DATABASE_URL=postgres://eshobe:eshobe@127.0.0.1:5432/eshobe \
//     pnpm exec tsx tests/deployment/ownership.ts
//
// It replays the srv1 incident on a real server: privileged migrations leave
// objects owned by the privileged role on a no-grants database whose tables
// are runtime-owned, then pins what the one-shot step must guarantee.
import assert from 'node:assert/strict'
import { Client, Pool } from 'pg'

import {
  findPublicOwnershipViolations,
  normalizePublicOwnership,
  resolveRuntimeRole,
} from '../../src/lib/database-ownership'

const adminURL = process.env.DATABASE_URL
if (!adminURL) throw new Error('DATABASE_URL (privileged CI role) is required')
assert.equal(new URL(adminURL).username, 'eshobe', 'expected the privileged CI role')

const scratchDB = 'eshobe_ownership_test'
const runtimeRole = 'eshobe_app'
const runtimePassword = 'ownership-replay-only'

const admin = new Pool({ connectionString: adminURL })
admin.on('error', () => undefined) // idle-client terminations during teardown
let scratch: Pool | undefined
let createdRole = false

try {
  const superuser = await admin.query<{ rolsuper: boolean }>(
    'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
  )
  assert.equal(superuser.rows[0]?.rolsuper, true, 'this replay needs the privileged CI role')

  await admin.query(`DROP DATABASE IF EXISTS ${scratchDB} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${scratchDB}`)

  const existingRole = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [runtimeRole])
  createdRole = existingRole.rowCount === 0
  if (createdRole) {
    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
       NOREPLICATION NOBYPASSRLS PASSWORD '${runtimePassword}'`,
    )
  }

  const url = new URL(adminURL)
  url.pathname = `/${scratchDB}`
  scratch = new Pool({ connectionString: url.toString() })
  scratch.on('error', () => undefined)
  // TS narrowing of the outer `let` does not survive the closures below.
  const db: Pool = scratch

  // --- role resolution sanity (full unit coverage lives in
  // tests/int/migrations.int.spec.ts): the privileged URL itself must resolve,
  // and nothing is ever guessed when no source is present.
  assert.equal(resolveRuntimeRole({ DATABASE_URL: adminURL }), 'eshobe')
  assert.throws(() => resolveRuntimeRole({}), /Cannot determine the runtime database role/)

  // --- the production pre-state ----------------------------------------------
  // Tables/sequences runtime-owned with owner-only ACLs (no grants anywhere);
  // ENUM TYPES still owned by the privileged role — the original reason
  // migrations run privileged. Plus what a privileged deploy leaves behind.
  await db.query(`
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
  assert.equal(
    (
      await db.query('SELECT has_schema_privilege($1::text, $2::text, $3::text) AS ok', [
        runtimeRole,
        'public',
        'CREATE',
      ])
    ).rows[0].ok,
    false,
    'the runtime role must not be able to CREATE in public',
  )

  // --- normalise: one pass, everything in public to the runtime role ---------
  const changes = await normalizePublicOwnership(db, runtimeRole)
  assert.deepEqual(changes, { tables: 1, sequences: 1, views: 2, types: 4 })

  const relations = await scratch.query<{ name: string; owner: string; relacl: unknown }>(`
    SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner, c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'f', 'S', 'v', 'm', 'i')
    ORDER BY c.relname
  `)
  assert.ok(relations.rows.length > 6, 'expected the fixture relations')
  for (const row of relations.rows) {
    assert.equal(row.owner, runtimeRole, `${row.name} must be runtime-owned`)
    assert.equal(row.relacl, null, `${row.name} must keep owner-only ACLs — no GRANT model`)
  }
  const types = await scratch.query<{ name: string; owner: string; typacl: unknown }>(`
    SELECT t.typname AS name, pg_get_userbyid(t.typowner) AS owner, t.typacl
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_class rc ON rc.oid = t.typrelid
    WHERE n.nspname = 'public' AND t.typisdefined
      AND (t.typtype IN ('e', 'd', 'r', 'm') OR rc.relkind = 'c')
    ORDER BY t.typname
  `)
  assert.deepEqual(
    types.rows.map((row) => row.name),
    ['composite_new', 'domain_new', 'enum_channel_new', 'enum_channel_pre'],
  )
  for (const row of types.rows) {
    assert.equal(row.owner, runtimeRole, `type ${row.name} must be runtime-owned`)
    assert.equal(row.typacl, null, `type ${row.name} must keep owner-only ACLs`)
  }

  // --- the gate, including the incident query itself -------------------------
  assert.deepEqual(await findPublicOwnershipViolations(db, runtimeRole), [])
  assert.equal(
    (
      await db.query(`
        SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public'
          AND NOT has_table_privilege('${runtimeRole}', schemaname || '.' || tablename, 'SELECT')
      `)
    ).rows[0].n,
    0,
    'the srv1 incident query must return 0',
  )

  // --- the runtime role got back exactly what the incident took away ---------
  const appURL = new URL(adminURL)
  appURL.pathname = `/${scratchDB}`
  appURL.username = runtimeRole
  appURL.password = runtimePassword
  const app = new Client({ connectionString: appURL.toString() })
  await app.connect()
  try {
    await app.query("ALTER TYPE public.enum_channel_new ADD VALUE 'added_by_runtime'")
    await app.query('SELECT count(*) FROM public.payments_new')
    await app.query("INSERT INTO public.orders_pre (id, channel) VALUES (gen_random_uuid(), 'web')")
    await app.query("SELECT nextval('public.payments_new_seq')")
  } finally {
    await app.end()
  }

  // --- idempotence: a re-run with nothing changed issues no DDL --------------
  assert.deepEqual(await normalizePublicOwnership(db, runtimeRole), {
    tables: 0,
    sequences: 0,
    views: 0,
    types: 0,
  })
  assert.deepEqual(await findPublicOwnershipViolations(db, runtimeRole), [])

  // --- the gate fails closed on drift the normaliser has not covered ---------
  await db.query('CREATE TABLE public.stray_table (id int)')
  const violations = await findPublicOwnershipViolations(db, runtimeRole)
  assert.ok(
    violations.some((v) => v.name === 'public.stray_table'),
    'gate must see the stray table',
  )
  assert.ok(
    violations.some((v) => v.name === 'public.stray_table' && /owned by/.test(v.problem)),
    'gate must report the owner mismatch',
  )
  assert.deepEqual(await normalizePublicOwnership(db, runtimeRole), {
    tables: 1,
    sequences: 0,
    views: 0,
    types: 0,
  })
  assert.deepEqual(await findPublicOwnershipViolations(db, runtimeRole), [])

  // --- an unknown role is refused, not guessed and not half-run --------------
  await assert.rejects(
    () => normalizePublicOwnership(db, 'eshobe_no_such_role'),
    /Runtime database role "eshobe_no_such_role" does not exist/,
  )
  await assert.rejects(
    () => findPublicOwnershipViolations(db, 'eshobe_no_such_role'),
    /does not exist/,
  )

  console.log('Ownership replay: normalisation, gate, idempotence and fail-closed behaviour OK')
} finally {
  await scratch?.end().catch(() => undefined)
  await admin.query(`DROP DATABASE IF EXISTS ${scratchDB} WITH (FORCE)`).catch(() => undefined)
  if (createdRole) {
    await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => undefined)
  }
  await admin.end().catch(() => undefined)
}
