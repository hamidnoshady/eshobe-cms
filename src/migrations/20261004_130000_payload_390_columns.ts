import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Columns Payload 3.90 adds to existing collections, missed by the 3.88 → 3.90.2
 * upgrade (5f47f00). Without them a migrated database fails every read of the
 * collection: the admin dies on `column users.reset_password_requested_at does not
 * exist` the moment it loads.
 *
 * - `users.reset_password_requested_at`: `forgotPassword.minRequestInterval` now
 *   defaults to 15s, which adds this hidden auth field to every auth collection.
 * - `media._objectkey`: `@payloadcms/plugin-cloud-storage` stores the object key
 *   it signed for an upload.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reset_password_requested_at" timestamp(3) with time zone;
    ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "_objectkey" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "media" DROP COLUMN IF EXISTS "_objectkey";
    ALTER TABLE "users" DROP COLUMN IF EXISTS "reset_password_requested_at";
  `)
}
