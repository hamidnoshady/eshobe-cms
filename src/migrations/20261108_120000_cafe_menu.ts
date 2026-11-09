import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Café menu projection (ESH-149). Additive: old stores stay in catalog mode,
 * available, and CMS-inventory-managed. The unique indexes are the race-safe
 * identity boundary for lost responses and concurrent POS retries.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN CREATE TYPE "public"."enum_pages_blocks_product_grid_mode" AS ENUM ('catalog', 'cafe'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum__pages_v_blocks_product_grid_mode" AS ENUM ('catalog', 'cafe'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum_products_menu_availability" AS ENUM ('available', 'sold_out', 'unavailable'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE TYPE "public"."enum__products_v_version_menu_availability" AS ENUM ('available', 'sold_out', 'unavailable'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    ALTER TABLE "pages_blocks_product_grid" ADD COLUMN IF NOT EXISTS "mode" "enum_pages_blocks_product_grid_mode" DEFAULT 'catalog';
    ALTER TABLE "_pages_v_blocks_product_grid" ADD COLUMN IF NOT EXISTS "mode" "enum__pages_v_blocks_product_grid_mode" DEFAULT 'catalog';
    ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "menu_source_system" varchar;
    ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "menu_source_id" varchar;
    ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "external_inventory" boolean DEFAULT false;
    ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "menu_availability" "enum_products_menu_availability" DEFAULT 'available';
    ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "menu_order" numeric DEFAULT 0;
    ALTER TABLE "_products_v" ADD COLUMN IF NOT EXISTS "version_menu_source_system" varchar;
    ALTER TABLE "_products_v" ADD COLUMN IF NOT EXISTS "version_menu_source_id" varchar;
    ALTER TABLE "_products_v" ADD COLUMN IF NOT EXISTS "version_external_inventory" boolean DEFAULT false;
    ALTER TABLE "_products_v" ADD COLUMN IF NOT EXISTS "version_menu_availability" "enum__products_v_version_menu_availability" DEFAULT 'available';
    ALTER TABLE "_products_v" ADD COLUMN IF NOT EXISTS "version_menu_order" numeric DEFAULT 0;
    ALTER TABLE "taxonomy_terms" ADD COLUMN IF NOT EXISTS "menu_source_system" varchar;
    ALTER TABLE "taxonomy_terms" ADD COLUMN IF NOT EXISTS "menu_source_id" varchar;
    ALTER TABLE "taxonomy_definitions" ADD COLUMN IF NOT EXISTS "cafe_menu_identity" varchar;
    UPDATE "taxonomy_definitions" SET "cafe_menu_identity" = CASE WHEN "key" = 'cafe_menu_category' THEN 'cafe_menu_category' ELSE NULL END;
    DO $$ BEGIN
      ALTER TABLE "taxonomy_definitions" ADD CONSTRAINT "taxonomy_definitions_cafe_menu_identity_check"
        CHECK ("cafe_menu_identity" IS NOT DISTINCT FROM (CASE WHEN "key" = 'cafe_menu_category' THEN 'cafe_menu_category' ELSE NULL END));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    ALTER TABLE "orders_items" ADD COLUMN IF NOT EXISTS "external_inventory" boolean DEFAULT false;

    CREATE TABLE IF NOT EXISTS "products_modifier_groups" (
      "_order" integer NOT NULL, "_parent_id" uuid NOT NULL CONSTRAINT "products_modifier_groups_parent_id_fk" REFERENCES "products"("id") ON DELETE CASCADE,
      "id" varchar PRIMARY KEY, "source_id" varchar, "min_selections" numeric DEFAULT 0,
      "max_selections" numeric DEFAULT 1, "active" boolean DEFAULT true, "menu_order" numeric DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "products_modifier_groups_locales" (
      "label" varchar, "id" serial PRIMARY KEY, "_locale" "_locales" NOT NULL,
      "_parent_id" varchar NOT NULL CONSTRAINT "products_modifier_groups_locales_parent_id_fk" REFERENCES "products_modifier_groups"("id") ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "products_modifier_groups_options" (
      "_order" integer NOT NULL, "_parent_id" varchar NOT NULL CONSTRAINT "products_modifier_groups_options_parent_id_fk" REFERENCES "products_modifier_groups"("id") ON DELETE CASCADE,
      "id" varchar PRIMARY KEY, "source_id" varchar, "price_delta" numeric DEFAULT 0,
      "active" boolean DEFAULT true, "menu_order" numeric DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "products_modifier_groups_options_locales" (
      "label" varchar, "id" serial PRIMARY KEY, "_locale" "_locales" NOT NULL,
      "_parent_id" varchar NOT NULL CONSTRAINT "products_modifier_groups_options_locales_parent_id_fk" REFERENCES "products_modifier_groups_options"("id") ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "_products_v_version_modifier_groups" (
      "_order" integer NOT NULL, "_parent_id" uuid NOT NULL CONSTRAINT "_products_v_version_modifier_groups_parent_id_fk" REFERENCES "_products_v"("id") ON DELETE CASCADE,
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "source_id" varchar, "min_selections" numeric DEFAULT 0,
      "max_selections" numeric DEFAULT 1, "active" boolean DEFAULT true, "menu_order" numeric DEFAULT 0, "_uuid" varchar
    );
    CREATE TABLE IF NOT EXISTS "_products_v_version_modifier_groups_locales" (
      "label" varchar, "id" serial PRIMARY KEY, "_locale" "_locales" NOT NULL,
      "_parent_id" uuid NOT NULL CONSTRAINT "_products_v_version_modifier_groups_locales_parent_id_fk" REFERENCES "_products_v_version_modifier_groups"("id") ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "_products_v_version_modifier_groups_options" (
      "_order" integer NOT NULL, "_parent_id" uuid NOT NULL CONSTRAINT "_products_v_version_modifier_groups_options_parent_id_fk" REFERENCES "_products_v_version_modifier_groups"("id") ON DELETE CASCADE,
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "source_id" varchar, "price_delta" numeric DEFAULT 0,
      "active" boolean DEFAULT true, "menu_order" numeric DEFAULT 0, "_uuid" varchar
    );
    CREATE TABLE IF NOT EXISTS "_products_v_version_modifier_groups_options_locales" (
      "label" varchar, "id" serial PRIMARY KEY, "_locale" "_locales" NOT NULL,
      "_parent_id" uuid NOT NULL CONSTRAINT "_products_v_version_modifier_groups_options_locales_paren_fk" REFERENCES "_products_v_version_modifier_groups_options"("id") ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "orders_items_modifiers" (
      "_order" integer NOT NULL, "_parent_id" varchar NOT NULL CONSTRAINT "orders_items_modifiers_parent_id_fk" REFERENCES "orders_items"("id") ON DELETE CASCADE,
      "id" varchar PRIMARY KEY, "group_source_id" varchar NOT NULL, "group_label" varchar NOT NULL,
      "option_source_id" varchar NOT NULL, "option_label" varchar NOT NULL,
      "quantity" numeric NOT NULL DEFAULT 1, "price_delta" numeric NOT NULL
    );

    CREATE INDEX IF NOT EXISTS "products_menu_source_system_idx" ON "products" ("menu_source_system");
    CREATE INDEX IF NOT EXISTS "products_menu_source_id_idx" ON "products" ("menu_source_id");
    CREATE INDEX IF NOT EXISTS "_products_v_version_version_menu_source_system_idx" ON "_products_v" ("version_menu_source_system");
    CREATE INDEX IF NOT EXISTS "_products_v_version_version_menu_source_id_idx" ON "_products_v" ("version_menu_source_id");
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_menu_source_system_idx" ON "taxonomy_terms" ("menu_source_system");
    CREATE INDEX IF NOT EXISTS "taxonomy_terms_menu_source_id_idx" ON "taxonomy_terms" ("menu_source_id");
    -- These names match the schema-declared compound indexes, so a development
    -- push does not remove them. PostgreSQL permits multiple NULL identities.
    CREATE UNIQUE INDEX IF NOT EXISTS "site_menuSourceSystem_menuSourceId_1_idx" ON "products" ("site_id", "menu_source_system", "menu_source_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "site_menuSourceSystem_menuSourceId_idx" ON "taxonomy_terms" ("site_id", "menu_source_system", "menu_source_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "site_cafeMenuIdentity_idx" ON "taxonomy_definitions" ("site_id", "cafe_menu_identity");

    CREATE INDEX IF NOT EXISTS "products_modifier_groups_order_idx" ON "products_modifier_groups" ("_order");
    CREATE INDEX IF NOT EXISTS "products_modifier_groups_parent_id_idx" ON "products_modifier_groups" ("_parent_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "products_modifier_groups_locales_locale_parent_id_unique" ON "products_modifier_groups_locales" ("_locale", "_parent_id");
    CREATE INDEX IF NOT EXISTS "products_modifier_groups_options_order_idx" ON "products_modifier_groups_options" ("_order");
    CREATE INDEX IF NOT EXISTS "products_modifier_groups_options_parent_id_idx" ON "products_modifier_groups_options" ("_parent_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "products_modifier_groups_options_locales_locale_parent_id_un" ON "products_modifier_groups_options_locales" ("_locale", "_parent_id");
    CREATE INDEX IF NOT EXISTS "_products_v_version_modifier_groups_order_idx" ON "_products_v_version_modifier_groups" ("_order");
    CREATE INDEX IF NOT EXISTS "_products_v_version_modifier_groups_parent_id_idx" ON "_products_v_version_modifier_groups" ("_parent_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "_products_v_version_modifier_groups_locales_locale_parent_id" ON "_products_v_version_modifier_groups_locales" ("_locale", "_parent_id");
    CREATE INDEX IF NOT EXISTS "_products_v_version_modifier_groups_options_order_idx" ON "_products_v_version_modifier_groups_options" ("_order");
    CREATE INDEX IF NOT EXISTS "_products_v_version_modifier_groups_options_parent_id_idx" ON "_products_v_version_modifier_groups_options" ("_parent_id");
    CREATE UNIQUE INDEX IF NOT EXISTS "_products_v_version_modifier_groups_options_locales_locale_p" ON "_products_v_version_modifier_groups_options_locales" ("_locale", "_parent_id");
    CREATE INDEX IF NOT EXISTS "orders_items_modifiers_order_idx" ON "orders_items_modifiers" ("_order");
    CREATE INDEX IF NOT EXISTS "orders_items_modifiers_parent_id_idx" ON "orders_items_modifiers" ("_parent_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "site_cafeMenuIdentity_idx";
    DROP INDEX IF EXISTS "site_menuSourceSystem_menuSourceId_idx";
    DROP INDEX IF EXISTS "site_menuSourceSystem_menuSourceId_1_idx";
    DROP TABLE IF EXISTS "orders_items_modifiers" CASCADE;
    DROP TABLE IF EXISTS "_products_v_version_modifier_groups_options_locales" CASCADE;
    DROP TABLE IF EXISTS "_products_v_version_modifier_groups_options" CASCADE;
    DROP TABLE IF EXISTS "_products_v_version_modifier_groups_locales" CASCADE;
    DROP TABLE IF EXISTS "_products_v_version_modifier_groups" CASCADE;
    DROP TABLE IF EXISTS "products_modifier_groups_options_locales" CASCADE;
    DROP TABLE IF EXISTS "products_modifier_groups_options" CASCADE;
    DROP TABLE IF EXISTS "products_modifier_groups_locales" CASCADE;
    DROP TABLE IF EXISTS "products_modifier_groups" CASCADE;
    ALTER TABLE "orders_items" DROP COLUMN IF EXISTS "external_inventory";
    ALTER TABLE "taxonomy_definitions" DROP CONSTRAINT IF EXISTS "taxonomy_definitions_cafe_menu_identity_check";
    ALTER TABLE "taxonomy_definitions" DROP COLUMN IF EXISTS "cafe_menu_identity";
    ALTER TABLE "taxonomy_terms" DROP COLUMN IF EXISTS "menu_source_id", DROP COLUMN IF EXISTS "menu_source_system";
    ALTER TABLE "_products_v" DROP COLUMN IF EXISTS "version_menu_order", DROP COLUMN IF EXISTS "version_menu_availability", DROP COLUMN IF EXISTS "version_external_inventory", DROP COLUMN IF EXISTS "version_menu_source_id", DROP COLUMN IF EXISTS "version_menu_source_system";
    ALTER TABLE "products" DROP COLUMN IF EXISTS "menu_order", DROP COLUMN IF EXISTS "menu_availability", DROP COLUMN IF EXISTS "external_inventory", DROP COLUMN IF EXISTS "menu_source_id", DROP COLUMN IF EXISTS "menu_source_system";
    ALTER TABLE "_pages_v_blocks_product_grid" DROP COLUMN IF EXISTS "mode";
    ALTER TABLE "pages_blocks_product_grid" DROP COLUMN IF EXISTS "mode";
    DROP TYPE IF EXISTS "enum__products_v_version_menu_availability";
    DROP TYPE IF EXISTS "enum_products_menu_availability";
    DROP TYPE IF EXISTS "enum__pages_v_blocks_product_grid_mode";
    DROP TYPE IF EXISTS "enum_pages_blocks_product_grid_mode";
  `)
}
