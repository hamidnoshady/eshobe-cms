import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Page builder: how a photograph sits on the page, and finer column widths.
 *
 * - `mediaBlock` rows gain `size` (narrow / content / wide / full), `aspect` (a frame
 *   ratio from a short set, or `auto` / `original`) and a localized `caption`. Themes
 *   use them to size a frame by rule instead of rendering every image at its exact
 *   pixel ratio at full width. Defaults reproduce the previous behaviour.
 * - Content columns gain `oneQuarter` and `threeQuarters`.
 *
 * Hand-written like the other recent migrations: the last Payload schema snapshot
 * (20260925) predates later hand-written migrations, so `migrate:create` diffs against
 * a stale schema. Every statement is idempotent; the DDL was taken from a database
 * built with dev push from this exact config and compared against a migrated one.
 * `mediaGrid` and the rich-text `mediaBlock` fields live in JSON and need nothing here.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TYPE "public"."enum_pages_blocks_content_columns_size" ADD VALUE IF NOT EXISTS 'oneQuarter' BEFORE 'oneThird';
    ALTER TYPE "public"."enum_pages_blocks_content_columns_size" ADD VALUE IF NOT EXISTS 'threeQuarters' BEFORE 'full';
    ALTER TYPE "public"."enum__pages_v_blocks_content_columns_size" ADD VALUE IF NOT EXISTS 'oneQuarter' BEFORE 'oneThird';
    ALTER TYPE "public"."enum__pages_v_blocks_content_columns_size" ADD VALUE IF NOT EXISTS 'threeQuarters' BEFORE 'full';

    DO $$ BEGIN
      CREATE TYPE "public"."enum_pages_blocks_media_block_size" AS ENUM('narrow', 'content', 'wide', 'full');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_pages_blocks_media_block_aspect" AS ENUM('auto', '16/9', '3/2', '4/3', '1/1', '4/5', '3/4', 'original');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum__pages_v_blocks_media_block_size" AS ENUM('narrow', 'content', 'wide', 'full');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum__pages_v_blocks_media_block_aspect" AS ENUM('auto', '16/9', '3/2', '4/3', '1/1', '4/5', '3/4', 'original');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    ALTER TABLE "pages_blocks_media_block"
      ADD COLUMN IF NOT EXISTS "size" "enum_pages_blocks_media_block_size" DEFAULT 'content',
      ADD COLUMN IF NOT EXISTS "aspect" "enum_pages_blocks_media_block_aspect" DEFAULT 'auto';
    ALTER TABLE "_pages_v_blocks_media_block"
      ADD COLUMN IF NOT EXISTS "size" "enum__pages_v_blocks_media_block_size" DEFAULT 'content',
      ADD COLUMN IF NOT EXISTS "aspect" "enum__pages_v_blocks_media_block_aspect" DEFAULT 'auto';

    CREATE TABLE IF NOT EXISTS "pages_blocks_media_block_locales" (
      "caption" varchar,
      "id" serial PRIMARY KEY NOT NULL,
      "_locale" "_locales" NOT NULL,
      "_parent_id" varchar NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "_pages_v_blocks_media_block_locales" (
      "caption" varchar,
      "id" serial PRIMARY KEY NOT NULL,
      "_locale" "_locales" NOT NULL,
      "_parent_id" uuid NOT NULL
    );

    DO $$ BEGIN
      ALTER TABLE "pages_blocks_media_block_locales"
        ADD CONSTRAINT "pages_blocks_media_block_locales_parent_id_fk"
        FOREIGN KEY ("_parent_id") REFERENCES "public"."pages_blocks_media_block"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "_pages_v_blocks_media_block_locales"
        ADD CONSTRAINT "_pages_v_blocks_media_block_locales_parent_id_fk"
        FOREIGN KEY ("_parent_id") REFERENCES "public"."_pages_v_blocks_media_block"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS "pages_blocks_media_block_locales_locale_parent_id_unique"
      ON "pages_blocks_media_block_locales" USING btree ("_locale", "_parent_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "_pages_v_blocks_media_block_locales_locale_parent_id_unique"
      ON "_pages_v_blocks_media_block_locales" USING btree ("_locale", "_parent_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Postgres cannot drop an enum value, so the column enums are rebuilt; rows using a
  // new width fall back to the nearest old one rather than failing the rollback.
  await db.execute(sql`
    DROP TABLE IF EXISTS "_pages_v_blocks_media_block_locales" CASCADE;
    DROP TABLE IF EXISTS "pages_blocks_media_block_locales" CASCADE;

    ALTER TABLE "_pages_v_blocks_media_block" DROP COLUMN IF EXISTS "aspect", DROP COLUMN IF EXISTS "size";
    ALTER TABLE "pages_blocks_media_block" DROP COLUMN IF EXISTS "aspect", DROP COLUMN IF EXISTS "size";
    DROP TYPE IF EXISTS "public"."enum__pages_v_blocks_media_block_aspect";
    DROP TYPE IF EXISTS "public"."enum__pages_v_blocks_media_block_size";
    DROP TYPE IF EXISTS "public"."enum_pages_blocks_media_block_aspect";
    DROP TYPE IF EXISTS "public"."enum_pages_blocks_media_block_size";

    ALTER TABLE "pages_blocks_content_columns" ALTER COLUMN "size" DROP DEFAULT;
    ALTER TABLE "pages_blocks_content_columns" ALTER COLUMN "size" SET DATA TYPE text;
    UPDATE "pages_blocks_content_columns" SET "size" = 'oneThird' WHERE "size" = 'oneQuarter';
    UPDATE "pages_blocks_content_columns" SET "size" = 'twoThirds' WHERE "size" = 'threeQuarters';
    DROP TYPE "public"."enum_pages_blocks_content_columns_size";
    CREATE TYPE "public"."enum_pages_blocks_content_columns_size" AS ENUM('oneThird', 'half', 'twoThirds', 'full');
    ALTER TABLE "pages_blocks_content_columns"
      ALTER COLUMN "size" SET DATA TYPE "public"."enum_pages_blocks_content_columns_size"
      USING "size"::"public"."enum_pages_blocks_content_columns_size";
    ALTER TABLE "pages_blocks_content_columns" ALTER COLUMN "size" SET DEFAULT 'oneThird';

    ALTER TABLE "_pages_v_blocks_content_columns" ALTER COLUMN "size" DROP DEFAULT;
    ALTER TABLE "_pages_v_blocks_content_columns" ALTER COLUMN "size" SET DATA TYPE text;
    UPDATE "_pages_v_blocks_content_columns" SET "size" = 'oneThird' WHERE "size" = 'oneQuarter';
    UPDATE "_pages_v_blocks_content_columns" SET "size" = 'twoThirds' WHERE "size" = 'threeQuarters';
    DROP TYPE "public"."enum__pages_v_blocks_content_columns_size";
    CREATE TYPE "public"."enum__pages_v_blocks_content_columns_size" AS ENUM('oneThird', 'half', 'twoThirds', 'full');
    ALTER TABLE "_pages_v_blocks_content_columns"
      ALTER COLUMN "size" SET DATA TYPE "public"."enum__pages_v_blocks_content_columns_size"
      USING "size"::"public"."enum__pages_v_blocks_content_columns_size";
    ALTER TABLE "_pages_v_blocks_content_columns" ALTER COLUMN "size" SET DEFAULT 'oneThird';
  `)
}
