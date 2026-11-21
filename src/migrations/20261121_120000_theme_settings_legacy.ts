import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Theme-settings compatibility columns (#212 / ESH-181).
 *
 * Additive and nullable on purpose: an existing row keeps its `runtime_settings`
 * untouched, and a row that never needed preservation simply has `NULL` here. The
 * values are presentation data, never secrets, so no encryption layer is involved.
 *
 * `legacy_runtime_settings` holds values the current manifest no longer declares (or
 * whose type changed). `runtime_settings_meta` records the converter version, the
 * package and the preserved key list so an operator can audit and reverse a rollout.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "site_theme_settings" ADD COLUMN IF NOT EXISTS "legacy_runtime_settings" jsonb;
    ALTER TABLE "site_theme_settings" ADD COLUMN IF NOT EXISTS "runtime_settings_meta" jsonb;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "site_theme_settings" DROP COLUMN IF EXISTS "runtime_settings_meta";
    ALTER TABLE "site_theme_settings" DROP COLUMN IF EXISTS "legacy_runtime_settings";
  `)
}
