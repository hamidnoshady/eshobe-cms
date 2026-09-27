import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Execution-plane billing tables. Plans, subscriptions and invoices stay as a
 * read-only archive; these tables are the local projection and the usage outbox.
 *
 * `down` uses `DROP CONSTRAINT IF EXISTS` because `DROP TABLE … CASCADE` already
 * removes the locked-document foreign keys.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TYPE "public"."enum_billing_usage_outbox_meter_key" AS ENUM('cms.api_request', 'cms.origin_transfer_bytes', 'cms.bandwidth_bytes', 'cms.storage_byte_hour', 'cms.deployment', 'cms.build_second');
  CREATE TYPE "public"."enum_billing_usage_outbox_kind" AS ENUM('measurement', 'correction');
  CREATE TYPE "public"."enum_billing_usage_outbox_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'dead_letter');
  CREATE TYPE "public"."enum_billing_usage_samples_meter_key" AS ENUM('cms.api_request', 'cms.origin_transfer_bytes', 'cms.bandwidth_bytes', 'cms.storage_byte_hour', 'cms.deployment', 'cms.build_second');
  CREATE TYPE "public"."enum_central_entitlement_projections_source" AS ENUM('push', 'pull', 'migration');
  CREATE TYPE "public"."enum_billing_service_credentials_status" AS ENUM('active', 'revoked');

  CREATE TABLE "central_entitlement_projections" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "site_id" uuid,
    "version" numeric NOT NULL,
    "serving" boolean DEFAULT false NOT NULL,
    "plan_code" varchar,
    "subscription_status" varchar,
    "features" jsonb,
    "limits" jsonb,
    "billing_cycle_start" timestamp(3) with time zone,
    "billing_cycle_end" timestamp(3) with time zone,
    "effective_at" timestamp(3) with time zone,
    "received_at" timestamp(3) with time zone,
    "source" "enum_central_entitlement_projections_source" DEFAULT 'push' NOT NULL,
    "checksum" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "billing_usage_outbox" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "site_id" uuid,
    "event_id" varchar NOT NULL,
    "meter_key" "enum_billing_usage_outbox_meter_key" NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" varchar NOT NULL,
    "kind" "enum_billing_usage_outbox_kind" DEFAULT 'measurement' NOT NULL,
    "resource_type" varchar,
    "resource_id" varchar,
    "period_start" timestamp(3) with time zone NOT NULL,
    "period_end" timestamp(3) with time zone NOT NULL,
    "occurred_at" timestamp(3) with time zone NOT NULL,
    "dimensions" jsonb,
    "status" "enum_billing_usage_outbox_status" DEFAULT 'pending' NOT NULL,
    "attempt_count" numeric DEFAULT 0,
    "next_attempt_at" timestamp(3) with time zone,
    "last_attempt_at" timestamp(3) with time zone,
    "last_error" varchar,
    "sent_at" timestamp(3) with time zone,
    "corrects_event_id" varchar,
    "correction_reason" varchar,
    "actor" varchar,
    "lease_token" varchar,
    "exported_quantity" numeric,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "billing_usage_samples" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "site_id" uuid,
    "meter_key" "enum_billing_usage_samples_meter_key" NOT NULL,
    "quantity" numeric NOT NULL,
    "unit" varchar NOT NULL,
    "period_start" timestamp(3) with time zone NOT NULL,
    "period_end" timestamp(3) with time zone NOT NULL,
    "occurred_at" timestamp(3) with time zone NOT NULL,
    "resource_type" varchar,
    "resource_id" varchar,
    "dimensions" jsonb,
    "source" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "billing_storage_accounts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "site_id" uuid,
    "bytes" numeric DEFAULT 0 NOT NULL,
    "accrued_byte_ms" varchar DEFAULT '0' NOT NULL,
    "open_hour_start" timestamp(3) with time zone NOT NULL,
    "accounted_at" timestamp(3) with time zone NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "billing_service_credentials" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "label" varchar NOT NULL,
    "key_id" varchar NOT NULL,
    "secret" varchar NOT NULL,
    "status" "enum_billing_service_credentials_status" DEFAULT 'active' NOT NULL,
    "scopes" jsonb,
    "last_used_at" timestamp(3) with time zone,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "billing_replay_nonces" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "key_id" varchar NOT NULL,
    "body_hash" varchar NOT NULL,
    "seen_at" timestamp(3) with time zone NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  ALTER TABLE "feature_flags" ADD COLUMN "technically_available" boolean DEFAULT true;
  ALTER TABLE "site_entitlements" ADD COLUMN "technical_holds" jsonb;

  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE IF NOT EXISTS 'storageHealthCheck';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE IF NOT EXISTS 'billingIntegration';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE IF NOT EXISTS 'storageHealthCheck';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE IF NOT EXISTS 'billingIntegration';

  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "central_entitlement_projections_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "billing_usage_outbox_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "billing_usage_samples_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "billing_storage_accounts_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "billing_service_credentials_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "billing_replay_nonces_id" uuid;

  ALTER TABLE "central_entitlement_projections" ADD CONSTRAINT "central_entitlement_projections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "billing_usage_outbox" ADD CONSTRAINT "billing_usage_outbox_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "billing_usage_samples" ADD CONSTRAINT "billing_usage_samples_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "billing_storage_accounts" ADD CONSTRAINT "billing_storage_accounts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;

  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_central_entitlement_projections_fk" FOREIGN KEY ("central_entitlement_projections_id") REFERENCES "public"."central_entitlement_projections"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_billing_usage_outbox_fk" FOREIGN KEY ("billing_usage_outbox_id") REFERENCES "public"."billing_usage_outbox"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_billing_usage_samples_fk" FOREIGN KEY ("billing_usage_samples_id") REFERENCES "public"."billing_usage_samples"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_billing_storage_accounts_fk" FOREIGN KEY ("billing_storage_accounts_id") REFERENCES "public"."billing_storage_accounts"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_billing_service_credentials_fk" FOREIGN KEY ("billing_service_credentials_id") REFERENCES "public"."billing_service_credentials"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_billing_replay_nonces_fk" FOREIGN KEY ("billing_replay_nonces_id") REFERENCES "public"."billing_replay_nonces"("id") ON DELETE cascade ON UPDATE no action;

  CREATE UNIQUE INDEX "central_entitlement_projections_site_idx" ON "central_entitlement_projections" USING btree ("site_id");
  CREATE INDEX "central_entitlement_projections_updated_at_idx" ON "central_entitlement_projections" USING btree ("updated_at");
  CREATE INDEX "central_entitlement_projections_created_at_idx" ON "central_entitlement_projections" USING btree ("created_at");

  CREATE UNIQUE INDEX "billing_usage_outbox_event_id_idx" ON "billing_usage_outbox" USING btree ("event_id");
  CREATE INDEX "billing_usage_outbox_site_idx" ON "billing_usage_outbox" USING btree ("site_id");
  CREATE INDEX "billing_usage_outbox_meter_key_idx" ON "billing_usage_outbox" USING btree ("meter_key");
  CREATE INDEX "billing_usage_outbox_period_start_idx" ON "billing_usage_outbox" USING btree ("period_start");
  CREATE INDEX "billing_usage_outbox_status_idx" ON "billing_usage_outbox" USING btree ("status");
  CREATE INDEX "billing_usage_outbox_next_attempt_at_idx" ON "billing_usage_outbox" USING btree ("next_attempt_at");
  CREATE INDEX "billing_usage_outbox_sent_at_idx" ON "billing_usage_outbox" USING btree ("sent_at");
  CREATE INDEX "billing_usage_outbox_updated_at_idx" ON "billing_usage_outbox" USING btree ("updated_at");
  CREATE INDEX "billing_usage_outbox_created_at_idx" ON "billing_usage_outbox" USING btree ("created_at");

  CREATE INDEX "billing_usage_samples_site_idx" ON "billing_usage_samples" USING btree ("site_id");
  CREATE INDEX "billing_usage_samples_meter_key_idx" ON "billing_usage_samples" USING btree ("meter_key");
  CREATE INDEX "billing_usage_samples_period_start_idx" ON "billing_usage_samples" USING btree ("period_start");
  CREATE INDEX "billing_usage_samples_updated_at_idx" ON "billing_usage_samples" USING btree ("updated_at");
  CREATE INDEX "billing_usage_samples_created_at_idx" ON "billing_usage_samples" USING btree ("created_at");

  CREATE UNIQUE INDEX "billing_storage_accounts_site_idx" ON "billing_storage_accounts" USING btree ("site_id");
  CREATE INDEX "billing_storage_accounts_updated_at_idx" ON "billing_storage_accounts" USING btree ("updated_at");
  CREATE INDEX "billing_storage_accounts_created_at_idx" ON "billing_storage_accounts" USING btree ("created_at");

  CREATE UNIQUE INDEX "billing_service_credentials_key_id_idx" ON "billing_service_credentials" USING btree ("key_id");
  CREATE INDEX "billing_service_credentials_updated_at_idx" ON "billing_service_credentials" USING btree ("updated_at");
  CREATE INDEX "billing_service_credentials_created_at_idx" ON "billing_service_credentials" USING btree ("created_at");

  CREATE UNIQUE INDEX "billing_replay_nonces_body_hash_idx" ON "billing_replay_nonces" USING btree ("body_hash");
  CREATE INDEX "billing_replay_nonces_key_id_idx" ON "billing_replay_nonces" USING btree ("key_id");
  CREATE INDEX "billing_replay_nonces_updated_at_idx" ON "billing_replay_nonces" USING btree ("updated_at");
  CREATE INDEX "billing_replay_nonces_created_at_idx" ON "billing_replay_nonces" USING btree ("created_at");

  CREATE INDEX "payload_locked_documents_rels_central_entitlement_projections_id_idx" ON "payload_locked_documents_rels" USING btree ("central_entitlement_projections_id");
  CREATE INDEX "payload_locked_documents_rels_billing_usage_outbox_id_idx" ON "payload_locked_documents_rels" USING btree ("billing_usage_outbox_id");
  CREATE INDEX "payload_locked_documents_rels_billing_usage_samples_id_idx" ON "payload_locked_documents_rels" USING btree ("billing_usage_samples_id");
  CREATE INDEX "payload_locked_documents_rels_billing_storage_accounts_id_idx" ON "payload_locked_documents_rels" USING btree ("billing_storage_accounts_id");
  CREATE INDEX "payload_locked_documents_rels_billing_service_credentials_id_idx" ON "payload_locked_documents_rels" USING btree ("billing_service_credentials_id");
  CREATE INDEX "payload_locked_documents_rels_billing_replay_nonces_id_idx" ON "payload_locked_documents_rels" USING btree ("billing_replay_nonces_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "central_entitlement_projections" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "billing_usage_outbox" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "billing_usage_samples" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "billing_storage_accounts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "billing_service_credentials" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "billing_replay_nonces" DISABLE ROW LEVEL SECURITY;

  DROP TABLE "central_entitlement_projections" CASCADE;
  DROP TABLE "billing_usage_outbox" CASCADE;
  DROP TABLE "billing_usage_samples" CASCADE;
  DROP TABLE "billing_storage_accounts" CASCADE;
  DROP TABLE "billing_service_credentials" CASCADE;
  DROP TABLE "billing_replay_nonces" CASCADE;

  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_central_entitlement_projections_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_billing_usage_outbox_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_billing_usage_samples_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_billing_storage_accounts_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_billing_service_credentials_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_billing_replay_nonces_fk";

  DROP INDEX IF EXISTS "payload_locked_documents_rels_central_entitlement_projections_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_billing_usage_outbox_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_billing_usage_samples_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_billing_storage_accounts_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_billing_service_credentials_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_billing_replay_nonces_id_idx";

  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "central_entitlement_projections_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "billing_usage_outbox_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "billing_usage_samples_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "billing_storage_accounts_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "billing_service_credentials_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "billing_replay_nonces_id";

  ALTER TABLE "feature_flags" DROP COLUMN IF EXISTS "technically_available";
  ALTER TABLE "site_entitlements" DROP COLUMN IF EXISTS "technical_holds";

  DROP TYPE IF EXISTS "public"."enum_billing_usage_outbox_meter_key";
  DROP TYPE IF EXISTS "public"."enum_billing_usage_outbox_kind";
  DROP TYPE IF EXISTS "public"."enum_billing_usage_outbox_status";
  DROP TYPE IF EXISTS "public"."enum_billing_usage_samples_meter_key";
  DROP TYPE IF EXISTS "public"."enum_central_entitlement_projections_source";
  DROP TYPE IF EXISTS "public"."enum_billing_service_credentials_status";
  `)
}
