import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sites_rendered_by" AS ENUM('platform', 'deployment');
  CREATE TYPE "public"."enum_theme_packages_site_types" AS ENUM('business', 'portfolio', 'store');
  CREATE TYPE "public"."enum_theme_packages_status" AS ENUM('draft', 'published', 'deprecated');
  CREATE TYPE "public"."enum_theme_packages_provider" AS ENUM('github');
  CREATE TYPE "public"."enum_theme_packages_visibility" AS ENUM('public', 'private');
  CREATE TYPE "public"."enum_theme_packages_build_pack" AS ENUM('nixpacks', 'dockerfile', 'static', 'dockercompose');
  CREATE TYPE "public"."enum_deploy_targets_provider" AS ENUM('coolify');
  CREATE TYPE "public"."enum_deploy_targets_git_source" AS ENUM('public', 'githubApp', 'deployKey');
  CREATE TYPE "public"."enum_site_deployments_status" AS ENUM('queued', 'creating', 'building', 'verifying', 'live', 'failed', 'stopped', 'removed');
  CREATE TYPE "public"."enum_site_deployments_domain_mode" AS ENUM('preview', 'edge', 'direct');
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'theme.published' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'deployment.started' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'deployment.live' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'deployment.failed' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'deployment.stopped' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'theme.published' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'deployment.started' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'deployment.live' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'deployment.failed' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'deployment.stopped' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'theme.published' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'deployment.started' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'deployment.live' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'deployment.failed' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'deployment.stopped' BEFORE 'storage.changed';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'advanceDeployments' BEFORE 'schedulePublish';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'advanceDeployments' BEFORE 'schedulePublish';
  CREATE TABLE "theme_packages_site_types" (
  	"order" integer NOT NULL,
  	"parent_id" uuid NOT NULL,
  	"value" "enum_theme_packages_site_types",
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
  );
  
  CREATE TABLE "theme_packages" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"key" varchar NOT NULL,
  	"description" varchar,
  	"status" "enum_theme_packages_status" DEFAULT 'draft' NOT NULL,
  	"provider" "enum_theme_packages_provider" DEFAULT 'github' NOT NULL,
  	"repository" varchar NOT NULL,
  	"visibility" "enum_theme_packages_visibility" DEFAULT 'public' NOT NULL,
  	"default_ref" varchar DEFAULT 'main' NOT NULL,
  	"pinned_commit" varchar,
  	"contract_version" numeric,
  	"manifest_synced_at" timestamp(3) with time zone,
  	"build_pack" "enum_theme_packages_build_pack",
  	"port" numeric,
  	"health_check_path" varchar,
  	"proxies_api" boolean,
  	"manifest" jsonb,
  	"env_schema" jsonb,
  	"sync_error" varchar,
  	"theme_template_id" uuid,
  	"default_target_id" uuid,
  	"required_feature" varchar,
  	"preview_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "deploy_targets" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"key" varchar NOT NULL,
  	"provider" "enum_deploy_targets_provider" DEFAULT 'coolify' NOT NULL,
  	"active" boolean DEFAULT true,
  	"base_url" varchar NOT NULL,
  	"api_token" varchar,
  	"clear_api_token" boolean DEFAULT false,
  	"token_summary" varchar,
  	"server_uuid" varchar NOT NULL,
  	"project_uuid" varchar NOT NULL,
  	"environment_name" varchar DEFAULT 'production' NOT NULL,
  	"git_source" "enum_deploy_targets_git_source" DEFAULT 'public' NOT NULL,
  	"github_app_uuid" varchar,
  	"private_key_uuid" varchar,
  	"wildcard_domain" varchar,
  	"notes" varchar,
  	"last_self_test_ok" boolean,
  	"last_self_test_detail" varchar,
  	"last_self_test_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_deployments" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"theme_package_id" uuid NOT NULL,
  	"target_id" uuid NOT NULL,
  	"status" "enum_site_deployments_status" DEFAULT 'queued' NOT NULL,
  	"domain_mode" "enum_site_deployments_domain_mode" DEFAULT 'preview' NOT NULL,
  	"domain" varchar,
  	"preview_domain" varchar,
  	"ref" varchar,
  	"commit_sha" varchar,
  	"app_uuid" varchar,
  	"last_deployment_uuid" varchar,
  	"api_key_id" uuid,
  	"revalidate_secret" varchar,
  	"last_error" varchar,
  	"log_tail" varchar,
  	"deployed_at" timestamp(3) with time zone,
  	"health_checked_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_theme_settings" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"theme_package_id" uuid NOT NULL,
  	"values" jsonb,
  	"secret_values" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_jobs_stats" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"stats" jsonb,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "sites" ADD COLUMN "rendered_by" "enum_sites_rendered_by" DEFAULT 'platform';
  ALTER TABLE "sites" ADD COLUMN "active_deployment_id" uuid;
  ALTER TABLE "payload_jobs" ADD COLUMN "meta" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "theme_packages_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "deploy_targets_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "site_deployments_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "site_theme_settings_id" uuid;
  ALTER TABLE "theme_packages_site_types" ADD CONSTRAINT "theme_packages_site_types_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."theme_packages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "theme_packages" ADD CONSTRAINT "theme_packages_theme_template_id_theme_templates_id_fk" FOREIGN KEY ("theme_template_id") REFERENCES "public"."theme_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "theme_packages" ADD CONSTRAINT "theme_packages_default_target_id_deploy_targets_id_fk" FOREIGN KEY ("default_target_id") REFERENCES "public"."deploy_targets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "theme_packages" ADD CONSTRAINT "theme_packages_preview_id_media_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_deployments" ADD CONSTRAINT "site_deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_deployments" ADD CONSTRAINT "site_deployments_theme_package_id_theme_packages_id_fk" FOREIGN KEY ("theme_package_id") REFERENCES "public"."theme_packages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_deployments" ADD CONSTRAINT "site_deployments_target_id_deploy_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."deploy_targets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_deployments" ADD CONSTRAINT "site_deployments_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_theme_settings" ADD CONSTRAINT "site_theme_settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_theme_settings" ADD CONSTRAINT "site_theme_settings_theme_package_id_theme_packages_id_fk" FOREIGN KEY ("theme_package_id") REFERENCES "public"."theme_packages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "theme_packages_site_types_order_idx" ON "theme_packages_site_types" USING btree ("order");
  CREATE INDEX "theme_packages_site_types_parent_idx" ON "theme_packages_site_types" USING btree ("parent_id");
  CREATE UNIQUE INDEX "theme_packages_key_idx" ON "theme_packages" USING btree ("key");
  CREATE INDEX "theme_packages_status_idx" ON "theme_packages" USING btree ("status");
  CREATE INDEX "theme_packages_theme_template_idx" ON "theme_packages" USING btree ("theme_template_id");
  CREATE INDEX "theme_packages_default_target_idx" ON "theme_packages" USING btree ("default_target_id");
  CREATE INDEX "theme_packages_preview_idx" ON "theme_packages" USING btree ("preview_id");
  CREATE INDEX "theme_packages_updated_at_idx" ON "theme_packages" USING btree ("updated_at");
  CREATE INDEX "theme_packages_created_at_idx" ON "theme_packages" USING btree ("created_at");
  CREATE UNIQUE INDEX "deploy_targets_key_idx" ON "deploy_targets" USING btree ("key");
  CREATE INDEX "deploy_targets_active_idx" ON "deploy_targets" USING btree ("active");
  CREATE INDEX "deploy_targets_updated_at_idx" ON "deploy_targets" USING btree ("updated_at");
  CREATE INDEX "deploy_targets_created_at_idx" ON "deploy_targets" USING btree ("created_at");
  CREATE INDEX "site_deployments_site_idx" ON "site_deployments" USING btree ("site_id");
  CREATE INDEX "site_deployments_theme_package_idx" ON "site_deployments" USING btree ("theme_package_id");
  CREATE INDEX "site_deployments_target_idx" ON "site_deployments" USING btree ("target_id");
  CREATE INDEX "site_deployments_status_idx" ON "site_deployments" USING btree ("status");
  CREATE INDEX "site_deployments_domain_idx" ON "site_deployments" USING btree ("domain");
  CREATE INDEX "site_deployments_commit_sha_idx" ON "site_deployments" USING btree ("commit_sha");
  CREATE INDEX "site_deployments_app_uuid_idx" ON "site_deployments" USING btree ("app_uuid");
  CREATE INDEX "site_deployments_api_key_idx" ON "site_deployments" USING btree ("api_key_id");
  CREATE INDEX "site_deployments_updated_at_idx" ON "site_deployments" USING btree ("updated_at");
  CREATE INDEX "site_deployments_created_at_idx" ON "site_deployments" USING btree ("created_at");
  CREATE UNIQUE INDEX "site_theme_settings_site_idx" ON "site_theme_settings" USING btree ("site_id");
  CREATE INDEX "site_theme_settings_theme_package_idx" ON "site_theme_settings" USING btree ("theme_package_id");
  CREATE INDEX "site_theme_settings_updated_at_idx" ON "site_theme_settings" USING btree ("updated_at");
  CREATE INDEX "site_theme_settings_created_at_idx" ON "site_theme_settings" USING btree ("created_at");
  ALTER TABLE "sites" ADD CONSTRAINT "sites_active_deployment_id_site_deployments_id_fk" FOREIGN KEY ("active_deployment_id") REFERENCES "public"."site_deployments"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_theme_packages_fk" FOREIGN KEY ("theme_packages_id") REFERENCES "public"."theme_packages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_deploy_targets_fk" FOREIGN KEY ("deploy_targets_id") REFERENCES "public"."deploy_targets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_deployments_fk" FOREIGN KEY ("site_deployments_id") REFERENCES "public"."site_deployments"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_theme_settings_fk" FOREIGN KEY ("site_theme_settings_id") REFERENCES "public"."site_theme_settings"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "sites_rendered_by_idx" ON "sites" USING btree ("rendered_by");
  CREATE INDEX "sites_active_deployment_idx" ON "sites" USING btree ("active_deployment_id");
  CREATE INDEX "payload_locked_documents_rels_theme_packages_id_idx" ON "payload_locked_documents_rels" USING btree ("theme_packages_id");
  CREATE INDEX "payload_locked_documents_rels_deploy_targets_id_idx" ON "payload_locked_documents_rels" USING btree ("deploy_targets_id");
  CREATE INDEX "payload_locked_documents_rels_site_deployments_id_idx" ON "payload_locked_documents_rels" USING btree ("site_deployments_id");
  CREATE INDEX "payload_locked_documents_rels_site_theme_settings_id_idx" ON "payload_locked_documents_rels" USING btree ("site_theme_settings_id");`)
}

/**
 * Hand-edit, deliberate and load-bearing: every `DROP CONSTRAINT` and `DROP INDEX`
 * below carries `IF EXISTS`, which `payload migrate:create` does not generate.
 *
 * The generator emits the drops in schema order without accounting for the
 * `DROP TABLE ... CASCADE` statements a few lines above them, and CASCADE has already
 * taken the foreign keys and indexes that pointed at those tables with it. Run as
 * generated, this function aborts on
 * `constraint "sites_active_deployment_id_site_deployments_id_fk" does not exist`
 * and rolls back — meaning the down path did not work at all. Verified by running
 * up → down → up against a database migrated to the previous migration.
 *
 * Re-generating this migration will silently reintroduce the bug.
 */
export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "theme_packages_site_types" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "theme_packages" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "deploy_targets" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_deployments" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_theme_settings" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_jobs_stats" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "theme_packages_site_types" CASCADE;
  DROP TABLE "theme_packages" CASCADE;
  DROP TABLE "deploy_targets" CASCADE;
  DROP TABLE "site_deployments" CASCADE;
  DROP TABLE "site_theme_settings" CASCADE;
  DROP TABLE "payload_jobs_stats" CASCADE;
  ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "sites_active_deployment_id_site_deployments_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_theme_packages_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_deploy_targets_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_site_deployments_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_site_theme_settings_fk";
  
  ALTER TABLE "webhooks_events" ALTER COLUMN "value" SET DATA TYPE text;
  DROP TYPE "public"."enum_webhooks_events";
  CREATE TYPE "public"."enum_webhooks_events" AS ENUM('site.created', 'site.updated', 'site.suspended', 'site.resumed', 'site.deleted', 'domain.changed', 'domain.verified', 'subscription.created', 'subscription.changed', 'subscription.cancelled', 'subscription.expired', 'invoice.issued', 'invoice.paid', 'invoice.overdue', 'quota.warning', 'quota.exceeded', 'apikey.issued', 'apikey.revoked', 'plugin.changed', 'storage.changed', 'cdn.synced', 'order.paid', 'backup.completed', 'platform.settingsChanged');
  ALTER TABLE "webhooks_events" ALTER COLUMN "value" SET DATA TYPE "public"."enum_webhooks_events" USING "value"::"public"."enum_webhooks_events";
  ALTER TABLE "webhook_deliveries" ALTER COLUMN "event" SET DATA TYPE text;
  DROP TYPE "public"."enum_webhook_deliveries_event";
  CREATE TYPE "public"."enum_webhook_deliveries_event" AS ENUM('site.created', 'site.updated', 'site.suspended', 'site.resumed', 'site.deleted', 'domain.changed', 'domain.verified', 'subscription.created', 'subscription.changed', 'subscription.cancelled', 'subscription.expired', 'invoice.issued', 'invoice.paid', 'invoice.overdue', 'quota.warning', 'quota.exceeded', 'apikey.issued', 'apikey.revoked', 'plugin.changed', 'storage.changed', 'cdn.synced', 'order.paid', 'backup.completed', 'platform.settingsChanged');
  ALTER TABLE "webhook_deliveries" ALTER COLUMN "event" SET DATA TYPE "public"."enum_webhook_deliveries_event" USING "event"::"public"."enum_webhook_deliveries_event";
  ALTER TABLE "audit_log" ALTER COLUMN "action" SET DATA TYPE text;
  DROP TYPE "public"."enum_audit_log_action";
  CREATE TYPE "public"."enum_audit_log_action" AS ENUM('site.created', 'site.updated', 'site.suspended', 'site.resumed', 'site.deleted', 'domain.changed', 'domain.verified', 'subscription.created', 'subscription.changed', 'subscription.cancelled', 'subscription.expired', 'invoice.issued', 'invoice.paid', 'invoice.overdue', 'quota.warning', 'quota.exceeded', 'apikey.issued', 'apikey.revoked', 'plugin.changed', 'storage.changed', 'cdn.synced', 'order.paid', 'backup.completed', 'platform.settingsChanged');
  ALTER TABLE "audit_log" ALTER COLUMN "action" SET DATA TYPE "public"."enum_audit_log_action" USING "action"::"public"."enum_audit_log_action";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'schedulePublish');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'schedulePublish');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX IF EXISTS "sites_rendered_by_idx";
  DROP INDEX IF EXISTS "sites_active_deployment_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_theme_packages_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_deploy_targets_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_site_deployments_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_site_theme_settings_id_idx";
  ALTER TABLE "sites" DROP COLUMN "rendered_by";
  ALTER TABLE "sites" DROP COLUMN "active_deployment_id";
  ALTER TABLE "payload_jobs" DROP COLUMN "meta";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "theme_packages_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "deploy_targets_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "site_deployments_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "site_theme_settings_id";
  DROP TYPE "public"."enum_sites_rendered_by";
  DROP TYPE "public"."enum_theme_packages_site_types";
  DROP TYPE "public"."enum_theme_packages_status";
  DROP TYPE "public"."enum_theme_packages_provider";
  DROP TYPE "public"."enum_theme_packages_visibility";
  DROP TYPE "public"."enum_theme_packages_build_pack";
  DROP TYPE "public"."enum_deploy_targets_provider";
  DROP TYPE "public"."enum_deploy_targets_git_source";
  DROP TYPE "public"."enum_site_deployments_status";
  DROP TYPE "public"."enum_site_deployments_domain_mode";`)
}
