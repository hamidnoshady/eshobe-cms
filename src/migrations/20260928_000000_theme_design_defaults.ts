import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Promote legacy catalogue paint into the canonical deployable Theme without touching site themes. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'enum_theme_packages_design_defaults_radius'
      ) THEN
        CREATE TYPE "public"."enum_theme_packages_design_defaults_radius" AS ENUM('none', 'sm', 'md', 'lg');
      END IF;
    END $$;

    ALTER TABLE "theme_packages"
      ADD COLUMN IF NOT EXISTS "design_defaults_primary" varchar,
      ADD COLUMN IF NOT EXISTS "design_defaults_accent" varchar,
      ADD COLUMN IF NOT EXISTS "design_defaults_background" varchar,
      ADD COLUMN IF NOT EXISTS "design_defaults_foreground" varchar,
      ADD COLUMN IF NOT EXISTS "design_defaults_radius" "enum_theme_packages_design_defaults_radius",
      ADD COLUMN IF NOT EXISTS "design_defaults_line_height" numeric;

    DO $$
    BEGIN
      IF to_regclass('public.theme_templates') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'theme_packages'
            AND column_name = 'theme_template_id'
        ) THEN
        UPDATE "theme_packages" p SET
          "design_defaults_primary" = t."tokens_primary",
          "design_defaults_accent" = t."tokens_accent",
          "design_defaults_background" = t."tokens_background",
          "design_defaults_foreground" = t."tokens_foreground",
          "design_defaults_radius" = t."tokens_radius"::text::"enum_theme_packages_design_defaults_radius",
          "design_defaults_line_height" = t."tokens_line_height"
        FROM "theme_templates" t WHERE p."theme_template_id" = t."id";
      END IF;
    END $$;

    ALTER TABLE "theme_packages" DROP CONSTRAINT IF EXISTS "theme_packages_theme_template_id_theme_templates_id_fk";
    DROP INDEX IF EXISTS "theme_packages_theme_template_idx";
    ALTER TABLE "theme_packages" DROP COLUMN IF EXISTS "theme_template_id";
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "theme_packages" ADD COLUMN IF NOT EXISTS "theme_template_id" uuid;
    DO $$
    BEGIN
      IF to_regclass('public.theme_templates') IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'theme_packages_theme_template_id_theme_templates_id_fk'
        ) THEN
        ALTER TABLE "theme_packages" ADD CONSTRAINT "theme_packages_theme_template_id_theme_templates_id_fk" FOREIGN KEY ("theme_template_id") REFERENCES "public"."theme_templates"("id") ON DELETE set null;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS "theme_packages_theme_template_idx" ON "theme_packages" ("theme_template_id");
    ALTER TABLE "theme_packages"
      DROP COLUMN IF EXISTS "design_defaults_primary",
      DROP COLUMN IF EXISTS "design_defaults_accent",
      DROP COLUMN IF EXISTS "design_defaults_background",
      DROP COLUMN IF EXISTS "design_defaults_foreground",
      DROP COLUMN IF EXISTS "design_defaults_radius",
      DROP COLUMN IF EXISTS "design_defaults_line_height";
    DROP TYPE IF EXISTS "public"."enum_theme_packages_design_defaults_radius";
  `)
}
