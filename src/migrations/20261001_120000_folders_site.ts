import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * `payload-folders` joins the multi-tenant plugin, which adds a `site` relationship.
 *
 * Existing folders are backfilled from what they hold: a folder takes the site of any
 * media inside it or inside any subfolder, then — for a folder that holds only empty
 * subfolders or nothing — its parent's site. A folder still unattributed after that
 * (empty and at the root) stays NULL: tenant access hides it, a platform admin still
 * sees it and can assign it or delete it. Guessing a site for it would hand one
 * customer's folder name to another.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_folders" ADD COLUMN IF NOT EXISTS "site_id" uuid;
    ALTER TABLE "payload_folders" DROP CONSTRAINT IF EXISTS "payload_folders_site_id_sites_id_fk";
    ALTER TABLE "payload_folders" ADD CONSTRAINT "payload_folders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
    CREATE INDEX IF NOT EXISTS "payload_folders_site_idx" ON "payload_folders" USING btree ("site_id");

    -- Down from each folder to every descendant folder, then to the media they hold.
    WITH RECURSIVE tree AS (
      SELECT id AS root, id AS node FROM "payload_folders"
      UNION ALL
      SELECT tree.root, child.id FROM tree JOIN "payload_folders" child ON child.folder_id = tree.node
    ),
    owner AS (
      SELECT DISTINCT ON (tree.root) tree.root, m.site_id
      FROM tree JOIN "media" m ON m.folder_id = tree.node
      WHERE m.site_id IS NOT NULL
      ORDER BY tree.root, m.created_at
    )
    UPDATE "payload_folders" f SET site_id = owner.site_id
    FROM owner WHERE f.id = owner.root AND f.site_id IS NULL;

    -- Then up: an empty subfolder inherits from its nearest attributed ancestor.
    WITH RECURSIVE up AS (
      SELECT id AS node, folder_id AS ancestor FROM "payload_folders" WHERE site_id IS NULL
      UNION ALL
      SELECT up.node, p.folder_id FROM up JOIN "payload_folders" p ON p.id = up.ancestor
      WHERE p.site_id IS NULL
    )
    UPDATE "payload_folders" f SET site_id = p.site_id
    FROM up JOIN "payload_folders" p ON p.id = up.ancestor
    WHERE f.id = up.node AND f.site_id IS NULL AND p.site_id IS NOT NULL;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "payload_folders_site_idx";
    ALTER TABLE "payload_folders" DROP CONSTRAINT IF EXISTS "payload_folders_site_id_sites_id_fk";
    ALTER TABLE "payload_folders" DROP COLUMN IF EXISTS "site_id";
  `)
}
