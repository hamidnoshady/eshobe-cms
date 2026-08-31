import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Hand-patched. `payload migrate:create` generated this from a real drift between
 * the committed schema snapshot and the actual database: `20260827_113713_wave6_media_prefix`
 * already added `media.prefix` (and every already-migrated database already has it —
 * confirmed against a fresh `migrate` run of this repo's full history), but the
 * *snapshot* that `20260827_143142_wave7_store` recorded right after it is missing
 * the column, so every diff since has looked like `prefix` needs adding again.
 *
 * `IF NOT EXISTS`/`IF EXISTS` make this a no-op wherever the column is already
 * there (every real deployment) while still bringing a database that somehow
 * lacks it in line — and, more importantly, fix the *snapshot* going forward so
 * `20260831_180713_add_api_keys`'s own diff (generated right after this one) does
 * not drag the same phantom column along again.
 */
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "prefix" varchar DEFAULT '';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "media" DROP COLUMN IF EXISTS "prefix";`)
}
