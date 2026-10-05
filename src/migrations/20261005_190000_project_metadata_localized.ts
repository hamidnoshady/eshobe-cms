import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Project facts become per-language: `projectMetadata.location`, `.area`, `.status`,
 * `.client` and every `additionalFacts` row's `label` / `value`. The date stays one value.
 *
 * Before this, a Persian page and its English translation showed the same strings, so an
 * English project page read «نوشهر» (or a Persian page read "Structure").
 *
 * **No data is lost and nothing a visitor sees changes on upgrade.** Each existing value
 * is copied into *every* locale row the post already has (its `posts_locales` rows exist
 * because `title` is localized and required); only after the copy are the shared columns
 * dropped. Editors then translate at their own pace. `down` rebuilds the shared columns
 * from the Persian value, falling back to any other locale, before dropping the localized
 * ones.
 *
 * Hand-written like the other recent migrations (the last Payload schema snapshot is
 * stale). The DDL was taken from a database built by dev push from this exact config and
 * compared column-for-column against a database migrated with this file. Every step is
 * guarded, so a re-run — or a database that was dev-pushed already — is a no-op.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "posts_locales"
      ADD COLUMN IF NOT EXISTS "project_metadata_location" varchar,
      ADD COLUMN IF NOT EXISTS "project_metadata_area" varchar,
      ADD COLUMN IF NOT EXISTS "project_metadata_status" varchar,
      ADD COLUMN IF NOT EXISTS "project_metadata_client" varchar;
    ALTER TABLE "_posts_v_locales"
      ADD COLUMN IF NOT EXISTS "version_project_metadata_location" varchar,
      ADD COLUMN IF NOT EXISTS "version_project_metadata_area" varchar,
      ADD COLUMN IF NOT EXISTS "version_project_metadata_status" varchar,
      ADD COLUMN IF NOT EXISTS "version_project_metadata_client" varchar;

    CREATE TABLE IF NOT EXISTS "posts_project_metadata_additional_facts_locales" (
      "label" varchar,
      "value" varchar,
      "id" serial PRIMARY KEY NOT NULL,
      "_locale" "_locales" NOT NULL,
      "_parent_id" varchar NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "_posts_v_version_project_metadata_additional_facts_locales" (
      "label" varchar,
      "value" varchar,
      "id" serial PRIMARY KEY NOT NULL,
      "_locale" "_locales" NOT NULL,
      "_parent_id" uuid NOT NULL
    );

    DO $$ BEGIN
      ALTER TABLE "posts_project_metadata_additional_facts_locales"
        ADD CONSTRAINT "posts_project_metadata_additional_facts_locales_parent_id_fk"
        FOREIGN KEY ("_parent_id") REFERENCES "public"."posts_project_metadata_additional_facts"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE "_posts_v_version_project_metadata_additional_facts_locales"
        ADD CONSTRAINT "_posts_v_version_project_metadata_additional_facts_locale_fk"
        FOREIGN KEY ("_parent_id") REFERENCES "public"."_posts_v_version_project_metadata_additional_facts"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS "posts_project_metadata_additional_facts_locales_locale_paren"
      ON "posts_project_metadata_additional_facts_locales" USING btree ("_locale", "_parent_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "_posts_v_version_project_metadata_additional_facts_locales_l"
      ON "_posts_v_version_project_metadata_additional_facts_locales" USING btree ("_locale", "_parent_id");

    -- The array tables' order/parent indexes that dev push creates and 20260926 did not.
    -- Kept on down: they index columns that exist in both shapes.
    CREATE INDEX IF NOT EXISTS "posts_project_metadata_additional_facts_order_idx"
      ON "posts_project_metadata_additional_facts" USING btree ("_order");
    CREATE INDEX IF NOT EXISTS "posts_project_metadata_additional_facts_parent_id_idx"
      ON "posts_project_metadata_additional_facts" USING btree ("_parent_id");
    CREATE INDEX IF NOT EXISTS "_posts_v_version_project_metadata_additional_facts_order_idx"
      ON "_posts_v_version_project_metadata_additional_facts" USING btree ("_order");
    CREATE INDEX IF NOT EXISTS "_posts_v_version_project_metadata_additional_facts_parent_id_id"
      ON "_posts_v_version_project_metadata_additional_facts" USING btree ("_parent_id");

    -- Copy, only while the shared columns still exist (re-runs skip this block).
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'posts' AND column_name = 'project_metadata_location') THEN
        UPDATE "posts_locales" pl SET
          "project_metadata_location" = p."project_metadata_location",
          "project_metadata_area" = p."project_metadata_area",
          "project_metadata_status" = p."project_metadata_status",
          "project_metadata_client" = p."project_metadata_client"
        FROM "posts" p WHERE pl."_parent_id" = p."id";
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = '_posts_v' AND column_name = 'version_project_metadata_location') THEN
        UPDATE "_posts_v_locales" vl SET
          "version_project_metadata_location" = v."version_project_metadata_location",
          "version_project_metadata_area" = v."version_project_metadata_area",
          "version_project_metadata_status" = v."version_project_metadata_status",
          "version_project_metadata_client" = v."version_project_metadata_client"
        FROM "_posts_v" v WHERE vl."_parent_id" = v."id";
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'posts_project_metadata_additional_facts' AND column_name = 'label') THEN
        INSERT INTO "posts_project_metadata_additional_facts_locales" ("label", "value", "_locale", "_parent_id")
          SELECT f."label", f."value", pl."_locale", f."id"
          FROM "posts_project_metadata_additional_facts" f
          JOIN "posts_locales" pl ON pl."_parent_id" = f."_parent_id"
          ON CONFLICT ("_locale", "_parent_id") DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = '_posts_v_version_project_metadata_additional_facts' AND column_name = 'label') THEN
        INSERT INTO "_posts_v_version_project_metadata_additional_facts_locales" ("label", "value", "_locale", "_parent_id")
          SELECT f."label", f."value", vl."_locale", f."id"
          FROM "_posts_v_version_project_metadata_additional_facts" f
          JOIN "_posts_v_locales" vl ON vl."_parent_id" = f."_parent_id"
          ON CONFLICT ("_locale", "_parent_id") DO NOTHING;
      END IF;
    END $$;

    ALTER TABLE "posts"
      DROP COLUMN IF EXISTS "project_metadata_location",
      DROP COLUMN IF EXISTS "project_metadata_area",
      DROP COLUMN IF EXISTS "project_metadata_status",
      DROP COLUMN IF EXISTS "project_metadata_client";
    ALTER TABLE "_posts_v"
      DROP COLUMN IF EXISTS "version_project_metadata_location",
      DROP COLUMN IF EXISTS "version_project_metadata_area",
      DROP COLUMN IF EXISTS "version_project_metadata_status",
      DROP COLUMN IF EXISTS "version_project_metadata_client";
    ALTER TABLE "posts_project_metadata_additional_facts"
      DROP COLUMN IF EXISTS "label",
      DROP COLUMN IF EXISTS "value";
    ALTER TABLE "_posts_v_version_project_metadata_additional_facts"
      DROP COLUMN IF EXISTS "label",
      DROP COLUMN IF EXISTS "value";
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "posts"
      ADD COLUMN IF NOT EXISTS "project_metadata_location" varchar,
      ADD COLUMN IF NOT EXISTS "project_metadata_area" varchar,
      ADD COLUMN IF NOT EXISTS "project_metadata_status" varchar,
      ADD COLUMN IF NOT EXISTS "project_metadata_client" varchar;
    ALTER TABLE "_posts_v"
      ADD COLUMN IF NOT EXISTS "version_project_metadata_location" varchar,
      ADD COLUMN IF NOT EXISTS "version_project_metadata_area" varchar,
      ADD COLUMN IF NOT EXISTS "version_project_metadata_status" varchar,
      ADD COLUMN IF NOT EXISTS "version_project_metadata_client" varchar;
    ALTER TABLE "posts_project_metadata_additional_facts"
      ADD COLUMN IF NOT EXISTS "label" varchar,
      ADD COLUMN IF NOT EXISTS "value" varchar;
    ALTER TABLE "_posts_v_version_project_metadata_additional_facts"
      ADD COLUMN IF NOT EXISTS "label" varchar,
      ADD COLUMN IF NOT EXISTS "value" varchar;

    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'posts_locales' AND column_name = 'project_metadata_location') THEN
        -- One shared value again: Persian first, then any other language.
        UPDATE "posts" p SET
          "project_metadata_location" = src."project_metadata_location",
          "project_metadata_area" = src."project_metadata_area",
          "project_metadata_status" = src."project_metadata_status",
          "project_metadata_client" = src."project_metadata_client"
        FROM (
          SELECT DISTINCT ON ("_parent_id") *
          FROM "posts_locales"
          ORDER BY "_parent_id", ("_locale" = 'fa') DESC, "_locale"
        ) src WHERE src."_parent_id" = p."id";
        UPDATE "_posts_v" v SET
          "version_project_metadata_location" = src."version_project_metadata_location",
          "version_project_metadata_area" = src."version_project_metadata_area",
          "version_project_metadata_status" = src."version_project_metadata_status",
          "version_project_metadata_client" = src."version_project_metadata_client"
        FROM (
          SELECT DISTINCT ON ("_parent_id") *
          FROM "_posts_v_locales"
          ORDER BY "_parent_id", ("_locale" = 'fa') DESC, "_locale"
        ) src WHERE src."_parent_id" = v."id";
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'posts_project_metadata_additional_facts_locales') THEN
        UPDATE "posts_project_metadata_additional_facts" f SET "label" = src."label", "value" = src."value"
        FROM (
          SELECT DISTINCT ON ("_parent_id") *
          FROM "posts_project_metadata_additional_facts_locales"
          ORDER BY "_parent_id", ("_locale" = 'fa') DESC, "_locale"
        ) src WHERE src."_parent_id" = f."id";
        UPDATE "_posts_v_version_project_metadata_additional_facts" f SET "label" = src."label", "value" = src."value"
        FROM (
          SELECT DISTINCT ON ("_parent_id") *
          FROM "_posts_v_version_project_metadata_additional_facts_locales"
          ORDER BY "_parent_id", ("_locale" = 'fa') DESC, "_locale"
        ) src WHERE src."_parent_id" = f."id";
      END IF;
    END $$;

    -- The shared schema had NOT NULL label/value; a row no language filled cannot keep its place.
    DELETE FROM "posts_project_metadata_additional_facts" WHERE "label" IS NULL OR "value" IS NULL;
    DELETE FROM "_posts_v_version_project_metadata_additional_facts" WHERE "label" IS NULL OR "value" IS NULL;
    ALTER TABLE "posts_project_metadata_additional_facts" ALTER COLUMN "label" SET NOT NULL, ALTER COLUMN "value" SET NOT NULL;
    ALTER TABLE "_posts_v_version_project_metadata_additional_facts" ALTER COLUMN "label" SET NOT NULL, ALTER COLUMN "value" SET NOT NULL;

    DROP TABLE IF EXISTS "posts_project_metadata_additional_facts_locales" CASCADE;
    DROP TABLE IF EXISTS "_posts_v_version_project_metadata_additional_facts_locales" CASCADE;
    ALTER TABLE "posts_locales"
      DROP COLUMN IF EXISTS "project_metadata_location",
      DROP COLUMN IF EXISTS "project_metadata_area",
      DROP COLUMN IF EXISTS "project_metadata_status",
      DROP COLUMN IF EXISTS "project_metadata_client";
    ALTER TABLE "_posts_v_locales"
      DROP COLUMN IF EXISTS "version_project_metadata_location",
      DROP COLUMN IF EXISTS "version_project_metadata_area",
      DROP COLUMN IF EXISTS "version_project_metadata_status",
      DROP COLUMN IF EXISTS "version_project_metadata_client";
  `)
}
