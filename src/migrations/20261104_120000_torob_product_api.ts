import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Issue #183 — local Torob enrollment projection on `sites`.
 *
 * Additive and fail-closed: every existing site starts disconnected, unauthorized and
 * disabled. Biza Miz syncs the real state through the platform control API; the public
 * crawler endpoint reads this row without calling Growth.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."enum_sites_torob_authorization_state" AS ENUM('not_authorized', 'pending_approval', 'authorized', 'revoked');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "torob_connected" boolean DEFAULT false;
    ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "torob_enabled" boolean DEFAULT false;
    ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "torob_authorization_state" "public"."enum_sites_torob_authorization_state" DEFAULT 'not_authorized';
    ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "torob_shop_id" varchar;
    ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "torob_synced_at" timestamp(3) with time zone;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "sites" DROP COLUMN IF EXISTS "torob_synced_at";
    ALTER TABLE "sites" DROP COLUMN IF EXISTS "torob_shop_id";
    ALTER TABLE "sites" DROP COLUMN IF EXISTS "torob_authorization_state";
    ALTER TABLE "sites" DROP COLUMN IF EXISTS "torob_enabled";
    ALTER TABLE "sites" DROP COLUMN IF EXISTS "torob_connected";
    DROP TYPE IF EXISTS "public"."enum_sites_torob_authorization_state";
  `)
}
