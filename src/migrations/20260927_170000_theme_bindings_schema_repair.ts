import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Complete the schema changes that were omitted from
 * `20260927_160000_theme_bindings_lanes`.
 *
 * In particular, Payload includes every collection in its polymorphic document-lock
 * relation. Without `theme_bindings_id`, merely opening the admin UI makes the lock
 * query select a column that does not exist and the entire page returns HTTP 500.
 * This is a new migration rather than an edit to the previous one because that
 * migration is already recorded as applied in production.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- projectUuid became the legacy fallback when preview and production were
    -- split. New targets are allowed to populate only the lane-specific columns.
    ALTER TABLE "deploy_targets" ALTER COLUMN "project_uuid" DROP NOT NULL;

    -- Match the collection default for direct SQL inserts as well as Payload writes.
    ALTER TABLE "site_deployments"
      ALTER COLUMN "lane" SET DEFAULT 'preview'::"enum_site_deployments_lane";

    ALTER TABLE "payload_locked_documents_rels"
      ADD COLUMN IF NOT EXISTS "theme_bindings_id" uuid;

    -- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Keep this repair safe if an
    -- operator added the emergency column/constraint before the image was rebuilt.
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payload_locked_documents_rels_theme_bindings_fk'
          AND conrelid = 'public.payload_locked_documents_rels'::regclass
      ) THEN
        ALTER TABLE "payload_locked_documents_rels"
          ADD CONSTRAINT "payload_locked_documents_rels_theme_bindings_fk"
          FOREIGN KEY ("theme_bindings_id")
          REFERENCES "public"."theme_bindings"("id")
          ON DELETE cascade ON UPDATE no action;
      END IF;
    END
    $migration$;

    -- These are the indexes emitted by Payload's schema for the fields added in the
    -- previous migration. Most are performance fixes; the lock-relation index is
    -- also part of the system-table schema expected by Payload.
    CREATE INDEX IF NOT EXISTS "sites_assigned_theme_package_idx"
      ON "sites" USING btree ("assigned_theme_package_id");
    CREATE INDEX IF NOT EXISTS "site_deployments_lane_idx"
      ON "site_deployments" USING btree ("lane");
    CREATE INDEX IF NOT EXISTS "site_deployments_theme_binding_idx"
      ON "site_deployments" USING btree ("theme_binding_id");
    CREATE INDEX IF NOT EXISTS "theme_bindings_theme_package_idx"
      ON "theme_bindings" USING btree ("theme_package_id");
    CREATE INDEX IF NOT EXISTS "theme_bindings_target_idx"
      ON "theme_bindings" USING btree ("target_id");
    CREATE INDEX IF NOT EXISTS "theme_bindings_app_uuid_idx"
      ON "theme_bindings" USING btree ("app_uuid");
    CREATE INDEX IF NOT EXISTS "theme_bindings_state_idx"
      ON "theme_bindings" USING btree ("state");
    CREATE INDEX IF NOT EXISTS "theme_bindings_provisioning_deployment_idx"
      ON "theme_bindings" USING btree ("provisioning_deployment_id");
    CREATE INDEX IF NOT EXISTS "theme_bindings_updated_at_idx"
      ON "theme_bindings" USING btree ("updated_at");
    CREATE INDEX IF NOT EXISTS "theme_bindings_created_at_idx"
      ON "theme_bindings" USING btree ("created_at");
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_theme_bindings_id_idx"
      ON "payload_locked_documents_rels" USING btree ("theme_bindings_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "payload_locked_documents_rels_theme_bindings_id_idx";
    ALTER TABLE "payload_locked_documents_rels"
      DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_theme_bindings_fk";
    ALTER TABLE "payload_locked_documents_rels"
      DROP COLUMN IF EXISTS "theme_bindings_id";

    DROP INDEX IF EXISTS "theme_bindings_created_at_idx";
    DROP INDEX IF EXISTS "theme_bindings_updated_at_idx";
    DROP INDEX IF EXISTS "theme_bindings_provisioning_deployment_idx";
    DROP INDEX IF EXISTS "theme_bindings_state_idx";
    DROP INDEX IF EXISTS "theme_bindings_app_uuid_idx";
    DROP INDEX IF EXISTS "theme_bindings_target_idx";
    DROP INDEX IF EXISTS "theme_bindings_theme_package_idx";
    DROP INDEX IF EXISTS "site_deployments_theme_binding_idx";
    DROP INDEX IF EXISTS "site_deployments_lane_idx";
    DROP INDEX IF EXISTS "sites_assigned_theme_package_idx";

    ALTER TABLE "site_deployments" ALTER COLUMN "lane" DROP DEFAULT;

    -- Restore the legacy invariant before restoring its NOT NULL constraint.
    UPDATE "deploy_targets"
    SET "project_uuid" = COALESCE("production_project_uuid", "preview_project_uuid")
    WHERE "project_uuid" IS NULL;
    ALTER TABLE "deploy_targets" ALTER COLUMN "project_uuid" SET NOT NULL;
  `)
}
