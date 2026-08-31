import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_api_keys_role" AS ENUM('site', 'platform');
  CREATE TABLE "api_keys" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"role" "enum_api_keys_role" DEFAULT 'site' NOT NULL,
  	"site_id" uuid,
  	"key_hash" varchar,
  	"key_prefix" varchar,
  	"disabled_at" timestamp(3) with time zone,
  	"last_used_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "api_keys_id" uuid;
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "api_keys_site_idx" ON "api_keys" USING btree ("site_id");
  CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");
  CREATE INDEX "api_keys_updated_at_idx" ON "api_keys" USING btree ("updated_at");
  CREATE INDEX "api_keys_created_at_idx" ON "api_keys" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_api_keys_fk" FOREIGN KEY ("api_keys_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_api_keys_id_idx" ON "payload_locked_documents_rels" USING btree ("api_keys_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Hand-patched: `DROP TABLE ... CASCADE` already removes the
  // `payload_locked_documents_rels_api_keys_fk` constraint along with the table,
  // so the generated `DROP CONSTRAINT` (no `IF EXISTS`) throws on a clean `down`.
  // Same bug class `20260827_143142_wave7_store.ts` was patched for — see CLAUDE.md.
  await db.execute(sql`
   ALTER TABLE "api_keys" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "api_keys" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_api_keys_fk";

  DROP INDEX "payload_locked_documents_rels_api_keys_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "api_keys_id";
  DROP TYPE "public"."enum_api_keys_role";`)
}
