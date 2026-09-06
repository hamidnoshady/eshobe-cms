import type { PostgresAdapterArgs as PostgresOptions } from '@payloadcms/db-postgres'

type Env = Record<string, string | undefined>

// Shared by the runtime and the one-shot migrator. Keep schema options identical;
// only the connection and the migrator's safety switches should differ.
// UUID, not serial: tenants share one database, so IDs must not be enumerable.
const schemaOptions = { idType: 'uuid' } as const

export const runtimeDatabaseOptions = (env: Env = process.env): PostgresOptions => ({
  ...schemaOptions,
  pool: { connectionString: env.DATABASE_URL },
  // No prodMigrations. Payload's default push behaviour is unchanged in dev;
  // production never pushes and migrations belong to `pnpm migrate` only.
})

export const migrationDatabaseOptions = (env: Env = process.env): PostgresOptions => {
  const connectionString = env.MIGRATE_DATABASE_URL
  if (!connectionString?.trim()) {
    throw new Error('MIGRATE_DATABASE_URL is required. DATABASE_URL is never a migration fallback.')
  }

  // Reject typos without echoing a privileged credential (including in URL errors).
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('MIGRATE_DATABASE_URL must be a valid PostgreSQL connection URL.')
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.hostname ||
    url.pathname.length < 2
  ) {
    throw new Error('MIGRATE_DATABASE_URL must name a PostgreSQL user, host and database.')
  }

  return {
    ...schemaOptions,
    pool: { connectionString },
    push: false,
    // A misspelled database name must fail, not create and migrate a new database.
    disableCreateDatabase: true,
  }
}
