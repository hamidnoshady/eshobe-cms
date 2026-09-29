import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Additive and null-safe: a site with no home logo keeps using its primary logo. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "site_branding" ADD COLUMN IF NOT EXISTS "home_logo_id" uuid;
    ALTER TABLE "site_branding" DROP CONSTRAINT IF EXISTS "site_branding_home_logo_id_media_id_fk";
    ALTER TABLE "site_branding" ADD CONSTRAINT "site_branding_home_logo_id_media_id_fk" FOREIGN KEY ("home_logo_id") REFERENCES "media"("id") ON DELETE set null;
    CREATE INDEX IF NOT EXISTS "site_branding_home_logo_idx" ON "site_branding"("home_logo_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "site_branding_home_logo_idx";
    ALTER TABLE "site_branding" DROP CONSTRAINT IF EXISTS "site_branding_home_logo_id_media_id_fk";
    ALTER TABLE "site_branding" DROP COLUMN IF EXISTS "home_logo_id";
  `)
}
