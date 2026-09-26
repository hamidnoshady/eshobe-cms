import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "theme_packages" ADD COLUMN IF NOT EXISTS "github_last_delivery_id" varchar;
   ALTER TABLE "theme_packages" ADD COLUMN IF NOT EXISTS "github_webhook_received_at" timestamptz;
   ALTER TABLE "theme_packages" ADD COLUMN IF NOT EXISTS "github_last_auto_sync_at" timestamptz;
   ALTER TABLE "theme_packages" ADD COLUMN IF NOT EXISTS "github_last_auto_sync_error" text;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "theme_packages" DROP COLUMN IF EXISTS "github_last_auto_sync_error";
   ALTER TABLE "theme_packages" DROP COLUMN IF EXISTS "github_last_auto_sync_at";
   ALTER TABLE "theme_packages" DROP COLUMN IF EXISTS "github_webhook_received_at";
   ALTER TABLE "theme_packages" DROP COLUMN IF EXISTS "github_last_delivery_id";`)
}
