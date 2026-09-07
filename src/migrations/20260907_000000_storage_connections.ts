import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "storage_connections" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"endpoint" varchar NOT NULL,
  	"bucket" varchar NOT NULL,
  	"region" varchar DEFAULT 'default',
  	"force_path_style" boolean DEFAULT true,
  	"access_key_id" varchar NOT NULL,
  	"secret_access_key" varchar,
  	"clear_credentials" boolean DEFAULT false,
  	"credentials_summary" varchar,
  	"last_self_test_ok" boolean,
  	"last_self_test_detail" varchar,
  	"last_self_test_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "storage_connections_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_storage_connections_fk" FOREIGN KEY ("storage_connections_id") REFERENCES "public"."storage_connections"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "storage_connections_updated_at_idx" ON "storage_connections" USING btree ("updated_at");
  CREATE INDEX "storage_connections_created_at_idx" ON "storage_connections" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_storage_connections_id_idx" ON "payload_locked_documents_rels" USING btree ("storage_connections_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Hand-patched, same bug class as `20260831_181044_add_api_keys.ts` (see CLAUDE.md):
  // `DROP TABLE ... CASCADE` already removes
  // `payload_locked_documents_rels_storage_connections_fk` along with the table, so the
  // generated `DROP CONSTRAINT` — which has no `IF EXISTS` — throws and leaves `down`
  // half-applied. Kept idempotent.
  await db.execute(sql`
   ALTER TABLE "storage_connections" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "storage_connections" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_storage_connections_fk";
  DROP INDEX "payload_locked_documents_rels_storage_connections_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "storage_connections_id";`)
}
