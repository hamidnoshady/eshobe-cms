import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Additive and null-safe: existing sites continue to use their site name and slug-based content lookup. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "site_theme_settings" ADD COLUMN IF NOT EXISTS "runtime_settings" jsonb;
    ALTER TABLE "site_theme_settings" ADD COLUMN IF NOT EXISTS "content_bindings" jsonb;

    CREATE TABLE IF NOT EXISTS "site_branding" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "site_id" uuid,
      "display_name" varchar NOT NULL, "short_name" varchar,
      "primary_logo_id" uuid, "compact_logo_id" uuid, "light_logo_id" uuid, "dark_logo_id" uuid,
      "favicon_id" uuid, "social_image_id" uuid,
      "updated_at" timestamptz DEFAULT now() NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "site_branding_locales" (
      "tagline" varchar, "id" serial PRIMARY KEY NOT NULL, "_locale" "_locales" NOT NULL, "_parent_id" uuid NOT NULL
    );
    ALTER TABLE "site_branding" ADD CONSTRAINT "site_branding_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE set null;
    ALTER TABLE "site_branding_locales" ADD CONSTRAINT "site_branding_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "site_branding"("id") ON DELETE cascade;
    CREATE UNIQUE INDEX IF NOT EXISTS "site_branding_site_idx" ON "site_branding"("site_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "site_branding_locales_locale_parent_id_unique" ON "site_branding_locales"("_locale", "_parent_id");
    CREATE INDEX IF NOT EXISTS "site_branding_updated_at_idx" ON "site_branding"("updated_at");
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "site_branding_id" uuid;

    ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "project_metadata_location" varchar;
    ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "project_metadata_date" timestamptz;
    ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "project_metadata_area" varchar;
    ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "project_metadata_status" varchar;
    ALTER TABLE "posts" ADD COLUMN IF NOT EXISTS "project_metadata_client" varchar;
    ALTER TABLE "_posts_v" ADD COLUMN IF NOT EXISTS "version_project_metadata_location" varchar;
    ALTER TABLE "_posts_v" ADD COLUMN IF NOT EXISTS "version_project_metadata_date" timestamptz;
    ALTER TABLE "_posts_v" ADD COLUMN IF NOT EXISTS "version_project_metadata_area" varchar;
    ALTER TABLE "_posts_v" ADD COLUMN IF NOT EXISTS "version_project_metadata_status" varchar;
    ALTER TABLE "_posts_v" ADD COLUMN IF NOT EXISTS "version_project_metadata_client" varchar;
    CREATE TABLE IF NOT EXISTS "posts_project_metadata_additional_facts" (
      "_order" integer NOT NULL, "_parent_id" uuid NOT NULL, "id" varchar PRIMARY KEY NOT NULL, "label" varchar NOT NULL, "value" varchar NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "_posts_v_version_project_metadata_additional_facts" (
      "_order" integer NOT NULL, "_parent_id" uuid NOT NULL, "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "label" varchar NOT NULL, "value" varchar NOT NULL, "_uuid" varchar
    );
    ALTER TABLE "posts_project_metadata_additional_facts" ADD CONSTRAINT "posts_project_metadata_additional_facts_parent_fk" FOREIGN KEY ("_parent_id") REFERENCES "posts"("id") ON DELETE cascade;
    ALTER TABLE "_posts_v_version_project_metadata_additional_facts" ADD CONSTRAINT "_posts_v_project_facts_parent_fk" FOREIGN KEY ("_parent_id") REFERENCES "_posts_v"("id") ON DELETE cascade;

    ALTER TABLE "pages_blocks_contact" ADD COLUMN IF NOT EXISTS "latitude" numeric;
    ALTER TABLE "pages_blocks_contact" ADD COLUMN IF NOT EXISTS "longitude" numeric;
    ALTER TABLE "pages_blocks_contact" ADD COLUMN IF NOT EXISTS "map_url" varchar;
    ALTER TABLE "_pages_v_blocks_contact" ADD COLUMN IF NOT EXISTS "latitude" numeric;
    ALTER TABLE "_pages_v_blocks_contact" ADD COLUMN IF NOT EXISTS "longitude" numeric;
    ALTER TABLE "_pages_v_blocks_contact" ADD COLUMN IF NOT EXISTS "map_url" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "_posts_v_version_project_metadata_additional_facts" CASCADE;
    DROP TABLE IF EXISTS "posts_project_metadata_additional_facts" CASCADE;
    DROP TABLE IF EXISTS "site_branding_locales" CASCADE; DROP TABLE IF EXISTS "site_branding" CASCADE;
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "site_branding_id";
    ALTER TABLE "site_theme_settings" DROP COLUMN IF EXISTS "runtime_settings";
    ALTER TABLE "site_theme_settings" DROP COLUMN IF EXISTS "content_bindings";
    ALTER TABLE "posts" DROP COLUMN IF EXISTS "project_metadata_location";
    ALTER TABLE "posts" DROP COLUMN IF EXISTS "project_metadata_date";
    ALTER TABLE "posts" DROP COLUMN IF EXISTS "project_metadata_area";
    ALTER TABLE "posts" DROP COLUMN IF EXISTS "project_metadata_status";
    ALTER TABLE "posts" DROP COLUMN IF EXISTS "project_metadata_client";
    ALTER TABLE "_posts_v" DROP COLUMN IF EXISTS "version_project_metadata_location";
    ALTER TABLE "_posts_v" DROP COLUMN IF EXISTS "version_project_metadata_date";
    ALTER TABLE "_posts_v" DROP COLUMN IF EXISTS "version_project_metadata_area";
    ALTER TABLE "_posts_v" DROP COLUMN IF EXISTS "version_project_metadata_status";
    ALTER TABLE "_posts_v" DROP COLUMN IF EXISTS "version_project_metadata_client";
    ALTER TABLE "pages_blocks_contact" DROP COLUMN IF EXISTS "latitude";
    ALTER TABLE "pages_blocks_contact" DROP COLUMN IF EXISTS "longitude";
    ALTER TABLE "pages_blocks_contact" DROP COLUMN IF EXISTS "map_url";
    ALTER TABLE "_pages_v_blocks_contact" DROP COLUMN IF EXISTS "latitude";
    ALTER TABLE "_pages_v_blocks_contact" DROP COLUMN IF EXISTS "longitude";
    ALTER TABLE "_pages_v_blocks_contact" DROP COLUMN IF EXISTS "map_url";
  `)
}
