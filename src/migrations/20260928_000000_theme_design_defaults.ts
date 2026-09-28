import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Promote template paint into the canonical deployable theme without touching site themes. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_theme_packages_design_defaults_radius" AS ENUM('none', 'sm', 'md', 'lg');
    ALTER TABLE "theme_packages"
      ADD COLUMN "design_defaults_primary" varchar,
      ADD COLUMN "design_defaults_accent" varchar,
      ADD COLUMN "design_defaults_background" varchar,
      ADD COLUMN "design_defaults_foreground" varchar,
      ADD COLUMN "design_defaults_radius" "enum_theme_packages_design_defaults_radius",
      ADD COLUMN "design_defaults_line_height" numeric;
    UPDATE "theme_packages" p SET
      "design_defaults_primary" = t."tokens_primary",
      "design_defaults_accent" = t."tokens_accent",
      "design_defaults_background" = t."tokens_background",
      "design_defaults_foreground" = t."tokens_foreground",
      "design_defaults_radius" = t."tokens_radius"::text::"enum_theme_packages_design_defaults_radius",
      "design_defaults_line_height" = t."tokens_line_height"
    FROM "theme_templates" t WHERE p."theme_template_id" = t."id";
    ALTER TABLE "theme_packages" DROP CONSTRAINT IF EXISTS "theme_packages_theme_template_id_theme_templates_id_fk";
    DROP INDEX IF EXISTS "theme_packages_theme_template_idx";
    ALTER TABLE "theme_packages" DROP COLUMN "theme_template_id";
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "theme_packages" ADD COLUMN "theme_template_id" uuid;
    ALTER TABLE "theme_packages" ADD CONSTRAINT "theme_packages_theme_template_id_theme_templates_id_fk" FOREIGN KEY ("theme_template_id") REFERENCES "public"."theme_templates"("id") ON DELETE set null;
    CREATE INDEX "theme_packages_theme_template_idx" ON "theme_packages" ("theme_template_id");
    ALTER TABLE "theme_packages" DROP COLUMN "design_defaults_primary", DROP COLUMN "design_defaults_accent", DROP COLUMN "design_defaults_background", DROP COLUMN "design_defaults_foreground", DROP COLUMN "design_defaults_radius", DROP COLUMN "design_defaults_line_height";
    DROP TYPE "public"."enum_theme_packages_design_defaults_radius";
  `)
}
