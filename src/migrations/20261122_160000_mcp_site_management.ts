import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * MCP: let a tenant run its whole site through an assistant (issue #228 follow-up).
 *
 * The capability matrix grew from "content finds and updates" to the tenant's own
 * site surface: navigation and comments, custom content and taxonomies, design
 * tokens, read-only orders and site record, plus an **opt-in** delete for content
 * rows. Every new collection contributes a capability group to the MCP key
 * collection, and Payload stores each group's checkboxes as columns — so the key
 * table needs them or the plugin cannot read a key's grants.
 *
 * All additions are nullable booleans defaulting to `false`, which is what makes
 * this additive and safe: an existing key keeps exactly the grants it had, and
 * every new checkbox starts unticked. Delete is included here as a *column*, not
 * as a grant — the grant is per key and the form defaults it off.
 *
 * `ADD COLUMN IF NOT EXISTS` on purpose: a database created by the earlier blanket
 * matrix already has `*_delete` columns for the original collections, and a
 * migration that assumed absence would fail there while succeeding on a fresh one.
 *
 * It also settles the key lifecycle: `user_id` becomes nullable so the existing
 * `ON DELETE SET NULL` foreign key can actually fire. With the column NOT NULL,
 * deleting a user who held a key failed — and the seed, which replaces its users,
 * failed with it. `down` deliberately does not restore NOT NULL: rows may already
 * hold NULL by then, and a rollback that cannot run is worse than one that leaves
 * a column wider.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- The owner must be nullable: the plugin's FK is ON DELETE SET NULL so a
    -- deleted user leaves an unusable key, and a NOT NULL column made user
    -- deletion fail outright (#95 §3). The field is marked non-required in
    -- src/plugins/mcp.ts so a push-built database agrees.
    ALTER TABLE "payload_mcp_api_keys" ALTER COLUMN "user_id" DROP NOT NULL;

    -- Content collections that can now be deleted (opt-in per key).
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "pages_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "posts_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "media_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "categories_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "products_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "payload_folders_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "forms_create" boolean DEFAULT false;

    -- Navigation and moderation.
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "menus_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "menus_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "menus_update" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "menus_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "comments_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "comments_update" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "comments_delete" boolean DEFAULT false;

    -- Commerce reads and design singletons.
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "orders_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "theme_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "theme_update" boolean DEFAULT false;

    -- Custom content and taxonomy (the migration-era model).
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_type_definitions_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_type_definitions_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_type_definitions_update" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_entries_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_entries_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_entries_update" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_entries_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_definitions_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_definitions_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_definitions_update" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_terms_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_terms_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_terms_update" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "taxonomy_terms_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "entry_term_relations_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "entry_term_relations_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "entry_term_relations_delete" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_relations_find" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_relations_create" boolean DEFAULT false;
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "content_relations_delete" boolean DEFAULT false;

    -- The tenant's own site record, read-only.
    ALTER TABLE "payload_mcp_api_keys" ADD COLUMN IF NOT EXISTS "sites_find" boolean DEFAULT false;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "pages_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "posts_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "media_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "categories_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "products_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "payload_folders_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "forms_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "menus_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "menus_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "menus_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "menus_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "comments_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "comments_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "comments_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "orders_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "theme_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "theme_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_type_definitions_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_type_definitions_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_type_definitions_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_entries_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_entries_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_entries_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_entries_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_definitions_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_definitions_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_definitions_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_terms_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_terms_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_terms_update";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "taxonomy_terms_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "entry_term_relations_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "entry_term_relations_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "entry_term_relations_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_relations_find";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_relations_create";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "content_relations_delete";
    ALTER TABLE "payload_mcp_api_keys" DROP COLUMN IF EXISTS "sites_find";
  `)
}
