import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Shared CDN accounts and tenant CDN self-service.
 *
 * - `cdn_accounts`: the platform's own ArvanCloud/Cloudflare account, platform-wide
 *   (no `site` column — it is the operator's credential, like `storage_connections`).
 * - `cdn_zones` gains `account_id` (a zone may use the shared account instead of its
 *   own token), `managed_by` (platform | tenant), `sync_requested_at` (the queue
 *   marker the `cdnZoneSync` task drains) and the `pending_record_deletes` array.
 * - `cdn_zones_dns_records.source` marks which rows a tenant may rewrite. Existing
 *   rows default to `platform`, so nothing an operator wrote becomes tenant-editable.
 * - `cdnZoneSync` joins both job task-slug enums.
 *
 * Hand-written like the other recent migrations (the last Payload snapshot predates
 * them). The DDL was taken from a database built with dev push from this config and
 * compared against a migrated one; every statement is idempotent.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE IF NOT EXISTS 'cdnZoneSync' BEFORE 'schedulePublish';
    ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE IF NOT EXISTS 'cdnZoneSync' BEFORE 'schedulePublish';

    DO $$ BEGIN
      CREATE TYPE "public"."enum_cdn_accounts_provider" AS ENUM('arvancloud', 'cloudflare');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_cdn_accounts_arvan_domain_mode" AS ENUM('full', 'partial');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_cdn_zones_managed_by" AS ENUM('platform', 'tenant');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      CREATE TYPE "public"."enum_cdn_zones_dns_records_source" AS ENUM('platform', 'tenant');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    CREATE TABLE IF NOT EXISTS "cdn_accounts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "name" varchar NOT NULL,
      "provider" "enum_cdn_accounts_provider" NOT NULL,
      "enabled" boolean DEFAULT true,
      "tenant_self_service" boolean DEFAULT false,
      "credentials_api_token" varchar,
      "clear_credentials" boolean DEFAULT false,
      "credentials_summary" varchar,
      "cloudflare_account_id" varchar,
      "arvan_domain_mode" "enum_cdn_accounts_arvan_domain_mode" DEFAULT 'full',
      "arvan_plan_level" varchar,
      "origin_target" varchar,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "cdn_accounts_updated_at_idx" ON "cdn_accounts" USING btree ("updated_at");
    CREATE INDEX IF NOT EXISTS "cdn_accounts_created_at_idx" ON "cdn_accounts" USING btree ("created_at");

    ALTER TABLE "cdn_zones"
      ADD COLUMN IF NOT EXISTS "account_id" uuid,
      ADD COLUMN IF NOT EXISTS "managed_by" "enum_cdn_zones_managed_by" DEFAULT 'platform',
      ADD COLUMN IF NOT EXISTS "sync_requested_at" timestamp(3) with time zone;
    DO $$ BEGIN
      ALTER TABLE "cdn_zones" ADD CONSTRAINT "cdn_zones_account_id_cdn_accounts_id_fk"
        FOREIGN KEY ("account_id") REFERENCES "public"."cdn_accounts"("id") ON DELETE set null ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "cdn_zones_account_idx" ON "cdn_zones" USING btree ("account_id");

    ALTER TABLE "cdn_zones_dns_records"
      ADD COLUMN IF NOT EXISTS "source" "enum_cdn_zones_dns_records_source" DEFAULT 'platform';

    CREATE TABLE IF NOT EXISTS "cdn_zones_pending_record_deletes" (
      "_order" integer NOT NULL,
      "_parent_id" uuid NOT NULL,
      "id" varchar PRIMARY KEY NOT NULL,
      "provider_record_id" varchar
    );
    DO $$ BEGIN
      ALTER TABLE "cdn_zones_pending_record_deletes" ADD CONSTRAINT "cdn_zones_pending_record_deletes_parent_id_fk"
        FOREIGN KEY ("_parent_id") REFERENCES "public"."cdn_zones"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "cdn_zones_pending_record_deletes_order_idx" ON "cdn_zones_pending_record_deletes" USING btree ("_order");
    CREATE INDEX IF NOT EXISTS "cdn_zones_pending_record_deletes_parent_id_idx" ON "cdn_zones_pending_record_deletes" USING btree ("_parent_id");

    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "cdn_accounts_id" uuid;
    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cdn_accounts_fk"
        FOREIGN KEY ("cdn_accounts_id") REFERENCES "public"."cdn_accounts"("id") ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_cdn_accounts_id_idx" ON "payload_locked_documents_rels" USING btree ("cdn_accounts_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Postgres cannot drop an enum value, so the task-slug enums are rebuilt without
  // it; queued `cdnZoneSync` jobs are removed first or the cast back would fail.
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_cdn_accounts_fk";
    DROP INDEX IF EXISTS "payload_locked_documents_rels_cdn_accounts_id_idx";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "cdn_accounts_id";

    DROP TABLE IF EXISTS "cdn_zones_pending_record_deletes" CASCADE;
    ALTER TABLE "cdn_zones_dns_records" DROP COLUMN IF EXISTS "source";
    ALTER TABLE "cdn_zones" DROP CONSTRAINT IF EXISTS "cdn_zones_account_id_cdn_accounts_id_fk";
    DROP INDEX IF EXISTS "cdn_zones_account_idx";
    ALTER TABLE "cdn_zones"
      DROP COLUMN IF EXISTS "account_id",
      DROP COLUMN IF EXISTS "managed_by",
      DROP COLUMN IF EXISTS "sync_requested_at";
    DROP TABLE IF EXISTS "cdn_accounts" CASCADE;

    DROP TYPE IF EXISTS "public"."enum_cdn_zones_dns_records_source";
    DROP TYPE IF EXISTS "public"."enum_cdn_zones_managed_by";
    DROP TYPE IF EXISTS "public"."enum_cdn_accounts_arvan_domain_mode";
    DROP TYPE IF EXISTS "public"."enum_cdn_accounts_provider";

    DELETE FROM "payload_jobs_log" WHERE "task_slug" = 'cdnZoneSync';
    DELETE FROM "payload_jobs" WHERE "task_slug" = 'cdnZoneSync';
    ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
    DROP TYPE "public"."enum_payload_jobs_log_task_slug";
    CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'advanceDeployments', 'storageHealthCheck', 'billingIntegration', 'schedulePublish');
    ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
    ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
    DROP TYPE "public"."enum_payload_jobs_task_slug";
    CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'advanceDeployments', 'storageHealthCheck', 'billingIntegration', 'schedulePublish');
    ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  `)
}
