import { postgresAdapter } from '@payloadcms/db-postgres'
import { fileURLToPath } from 'node:url'
import { BasePayload, readMigrationFiles } from 'payload'

import { migrationDatabaseOptions } from '../src/lib/database'
import {
  assertPublicOwnershipForRuntime,
  normalizePublicOwnership,
  resolveRuntimeRole,
} from '../src/lib/database-ownership'

/**
 * One-shot production entrypoint, run through `payload run` for its TS loader.
 * Never launches Next.js, never copies MIGRATE_DATABASE_URL into DATABASE_URL,
 * and never uses the cached runtime Payload instance.
 */
const migrate = async (): Promise<void> => {
  const dbOptions = {
    ...migrationDatabaseOptions(),
    migrationDir: fileURLToPath(new URL('../src/migrations', import.meta.url)),
  }
  if (process.env.PAYLOAD_DROP_DATABASE === 'true') {
    throw new Error('Refusing to migrate with PAYLOAD_DROP_DATABASE=true.')
  }
  // Resolve before connecting: a deploy missing the role configuration must
  // fail fast and loudly, never run DDL and then guess who should own it.
  const runtimeRole = resolveRuntimeRole()

  // Set before importing app config: even a direct `payload run` invocation must
  // not push a schema, generate types, start jobs or enable development HMR.
  Object.assign(process.env, {
    NODE_ENV: 'production',
    PAYLOAD_MIGRATING: 'true',
    JOBS_AUTORUN: 'false',
    DISABLE_PAYLOAD_HMR: 'true',
  })

  const { default: appConfig } = await import('../src/payload.config')
  const config = await appConfig
  const payload = new BasePayload()
  try {
    await payload.init({
      config: {
        ...config,
        // Retain sanitized adapter metadata (UUID IDs), not the runtime pool.
        db: { ...config.db, init: postgresAdapter(dbOptions).init },
      },
      // Like `payload migrate`, this is database work, not an app boot.
      disableOnInit: true,
      cron: false,
    })

    // Payload's migrator prompts on a dev/push database and can exit 0 on cancel.
    // In a headless deploy that would either hang or falsely unblock web. Refuse
    // it before handing control to Payload; never auto-accept a data-loss prompt.
    const table = await payload.db.pool.query(
      "SELECT to_regclass('public.payload_migrations') AS name",
    )
    if (table.rows[0].name) {
      const dev = await payload.db.pool.query(
        'SELECT 1 FROM public.payload_migrations WHERE batch = -1 LIMIT 1',
      )
      if (dev.rowCount) {
        throw new Error(
          'Refusing to migrate a dev/push database (batch = -1). Use a migrated database.',
        )
      }
    }

    // Use the same ordered, transactional runner and tracking table as Payload's
    // CLI. Missing tooling/source must fail, not report "No migrations to run".
    const migrations = await readMigrationFiles({ payload })
    if (!migrations.length) throw new Error('No committed migrations found. Refusing to continue.')
    await payload.db.migrate({ migrations })
    payload.logger.info('All migrations completed successfully.')

    // The migrator connects as the privileged role, so everything it just
    // created — and, on this database, the enums earlier deploys left owned by
    // the privileged role — is invisible to the runtime role, which owns the
    // whole schema with no grants anywhere. Hand schema public over to the
    // runtime role (owner-only model), then prove it: if anything is left
    // inaccessible, exit non-zero so compose never starts web against it.
    const changes = await normalizePublicOwnership(payload.db.pool, runtimeRole)
    payload.logger.info(
      `Ownership normalised to runtime role "${runtimeRole}" (already-owned objects skipped): ` +
        `${changes.tables} tables, ${changes.sequences} sequences, ${changes.views} views, ` +
        `${changes.types} types reassigned.`,
    )
    await assertPublicOwnershipForRuntime(payload.db.pool, runtimeRole)
    payload.logger.info(
      `Ownership gate passed: everything in schema public is owned by and accessible to "${runtimeRole}".`,
    )
  } finally {
    if (payload.db) await payload.destroy()
  }
}

try {
  await migrate()
} catch (error) {
  console.error('Migration failed:', error)
  process.exit(1)
}
