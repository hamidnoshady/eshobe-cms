import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/** Additive migration: legacy target columns remain as runtime fallbacks. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'theme.artifact.ready' BEFORE 'deployment.started';
    ALTER TYPE "public"."enum_webhooks_events" ADD VALUE 'theme.artifact.failed' BEFORE 'deployment.started';
    ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'theme.artifact.ready' BEFORE 'deployment.started';
    ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE 'theme.artifact.failed' BEFORE 'deployment.started';
    ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'theme.artifact.ready' BEFORE 'deployment.started';
    ALTER TYPE "public"."enum_audit_log_action" ADD VALUE 'theme.artifact.failed' BEFORE 'deployment.started';

    CREATE TYPE "public"."enum_theme_packages_deployment_strategy" AS ENUM('coolify_build', 'registry_image');
    CREATE TYPE "public"."enum_theme_packages_allowed_deployment_strategies" AS ENUM('coolify_build', 'registry_image');
    CREATE TYPE "public"."enum_theme_packages_registry_provider" AS ENUM('ghcr');
    CREATE TYPE "public"."enum_theme_packages_registry_visibility" AS ENUM('public', 'private');
    ALTER TABLE "theme_packages" ADD COLUMN "deployment_strategy" "enum_theme_packages_deployment_strategy" DEFAULT 'coolify_build' NOT NULL;
    ALTER TABLE "theme_packages" ADD COLUMN "registry_provider" "enum_theme_packages_registry_provider";
    ALTER TABLE "theme_packages" ADD COLUMN "registry_image_repository" varchar;
    ALTER TABLE "theme_packages" ADD COLUMN "registry_visibility" "enum_theme_packages_registry_visibility" DEFAULT 'public';
    CREATE TABLE "theme_packages_allowed_deployment_strategies" (
      "order" integer NOT NULL, "parent_id" uuid NOT NULL,
      "value" "enum_theme_packages_allowed_deployment_strategies",
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
    );
    ALTER TABLE "theme_packages_allowed_deployment_strategies" ADD CONSTRAINT "theme_packages_allowed_deployment_strategies_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."theme_packages"("id") ON DELETE cascade;
    CREATE INDEX "theme_packages_allowed_deployment_strategies_order_idx" ON "theme_packages_allowed_deployment_strategies" ("order");
    CREATE INDEX "theme_packages_allowed_deployment_strategies_parent_idx" ON "theme_packages_allowed_deployment_strategies" ("parent_id");
    INSERT INTO "theme_packages_allowed_deployment_strategies" ("order", "parent_id", "value") SELECT 1, "id", 'coolify_build' FROM "theme_packages";

    ALTER TABLE "deploy_targets" ALTER COLUMN "server_uuid" DROP NOT NULL;
    ALTER TABLE "deploy_targets" ADD COLUMN "default_server_uuid" varchar;
    ALTER TABLE "deploy_targets" ADD COLUMN "preview_server_uuid" varchar;
    ALTER TABLE "deploy_targets" ADD COLUMN "preview_environment_name" varchar DEFAULT 'preview';
    ALTER TABLE "deploy_targets" ADD COLUMN "preview_wildcard_domain" varchar;
    ALTER TABLE "deploy_targets" ADD COLUMN "production_server_uuid" varchar;
    ALTER TABLE "deploy_targets" ADD COLUMN "production_environment_name" varchar DEFAULT 'production';
    ALTER TABLE "deploy_targets" ADD COLUMN "public_git_enabled" boolean DEFAULT true;
    ALTER TABLE "deploy_targets" ADD COLUMN "github_app_enabled" boolean DEFAULT false;
    ALTER TABLE "deploy_targets" ADD COLUMN "deploy_key_enabled" boolean DEFAULT false;
    ALTER TABLE "deploy_targets" ADD COLUMN "public_registry_pull_enabled" boolean DEFAULT true;
    ALTER TABLE "deploy_targets" ADD COLUMN "ghcr_enabled" boolean DEFAULT false;
    ALTER TABLE "deploy_targets" ADD COLUMN "ghcr_credential_uuid" varchar;
    UPDATE "deploy_targets" SET
      "default_server_uuid" = "server_uuid",
      "preview_environment_name" = COALESCE("environment_name", 'production'),
      "production_environment_name" = COALESCE("environment_name", 'production'),
      "preview_wildcard_domain" = "wildcard_domain",
      "public_git_enabled" = ("git_source" = 'public'),
      "github_app_enabled" = ("git_source" = 'githubApp'),
      "deploy_key_enabled" = ("git_source" = 'deployKey');

    CREATE TYPE "public"."enum_theme_artifacts_source" AS ENUM('github_actions', 'coolify_build', 'manual_registry');
    CREATE TYPE "public"."enum_theme_artifacts_registry_provider" AS ENUM('ghcr');
    CREATE TYPE "public"."enum_theme_artifacts_status" AS ENUM('queued', 'building', 'pushing', 'verifying', 'ready', 'failed', 'deprecated');
    CREATE TABLE "theme_artifacts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "immutable_key" varchar NOT NULL,
      "theme_package_id" uuid NOT NULL,
      "source" "enum_theme_artifacts_source" NOT NULL,
      "repository" varchar NOT NULL, "ref" varchar NOT NULL, "commit_sha" varchar NOT NULL,
      "registry_provider" "enum_theme_artifacts_registry_provider",
      "image_repository" varchar, "image_tag" varchar, "image_digest" varchar, "immutable_image" varchar,
      "platform" varchar, "status" "enum_theme_artifacts_status" DEFAULT 'queued' NOT NULL,
      "workflow_run_id" varchar, "workflow_run_url" varchar,
      "provenance_available" boolean DEFAULT false, "sbom_available" boolean DEFAULT false,
      "build_started_at" timestamp(3) with time zone, "build_finished_at" timestamp(3) with time zone,
      "last_error" varchar, "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    ALTER TABLE "theme_artifacts" ADD CONSTRAINT "theme_artifacts_theme_package_fk" FOREIGN KEY ("theme_package_id") REFERENCES "public"."theme_packages"("id") ON DELETE restrict;
    CREATE UNIQUE INDEX "theme_artifacts_immutable_key_idx" ON "theme_artifacts" ("immutable_key");
    CREATE INDEX "theme_artifacts_theme_package_idx" ON "theme_artifacts" ("theme_package_id");
    CREATE INDEX "theme_artifacts_commit_sha_idx" ON "theme_artifacts" ("commit_sha");
    CREATE INDEX "theme_artifacts_image_digest_idx" ON "theme_artifacts" ("image_digest");
    CREATE INDEX "theme_artifacts_status_idx" ON "theme_artifacts" ("status");
    CREATE INDEX "theme_artifacts_updated_at_idx" ON "theme_artifacts" ("updated_at");
    CREATE INDEX "theme_artifacts_created_at_idx" ON "theme_artifacts" ("created_at");

    CREATE TYPE "public"."enum_site_deployments_artifact_source" AS ENUM('source_build', 'registry_image');
    ALTER TABLE "site_deployments" ADD COLUMN "artifact_source" "enum_site_deployments_artifact_source" DEFAULT 'source_build';
    ALTER TABLE "site_deployments" ADD COLUMN "theme_artifact_id" uuid;
    ALTER TABLE "site_deployments" ADD COLUMN "image_repository" varchar;
    ALTER TABLE "site_deployments" ADD COLUMN "image_tag" varchar;
    ALTER TABLE "site_deployments" ADD COLUMN "image_digest" varchar;
    ALTER TABLE "site_deployments" ADD CONSTRAINT "site_deployments_theme_artifact_fk" FOREIGN KEY ("theme_artifact_id") REFERENCES "public"."theme_artifacts"("id") ON DELETE set null;
    CREATE INDEX "site_deployments_theme_artifact_idx" ON "site_deployments" ("theme_artifact_id");
    CREATE INDEX "site_deployments_image_digest_idx" ON "site_deployments" ("image_digest");

    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "theme_artifacts_id" uuid;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_theme_artifacts_fk" FOREIGN KEY ("theme_artifacts_id") REFERENCES "public"."theme_artifacts"("id") ON DELETE cascade;
    CREATE INDEX "payload_locked_documents_rels_theme_artifacts_id_idx" ON "payload_locked_documents_rels" ("theme_artifacts_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_theme_artifacts_fk";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "theme_artifacts_id";
    ALTER TABLE "site_deployments" DROP CONSTRAINT IF EXISTS "site_deployments_theme_artifact_fk";
    ALTER TABLE "site_deployments" DROP COLUMN IF EXISTS "artifact_source", DROP COLUMN IF EXISTS "theme_artifact_id", DROP COLUMN IF EXISTS "image_repository", DROP COLUMN IF EXISTS "image_tag", DROP COLUMN IF EXISTS "image_digest";
    DROP TABLE IF EXISTS "theme_artifacts";
    DROP TYPE IF EXISTS "enum_site_deployments_artifact_source";
    DROP TYPE IF EXISTS "enum_theme_artifacts_status"; DROP TYPE IF EXISTS "enum_theme_artifacts_registry_provider"; DROP TYPE IF EXISTS "enum_theme_artifacts_source";
    UPDATE "deploy_targets" SET "server_uuid" = COALESCE("server_uuid", "default_server_uuid", "preview_server_uuid", "production_server_uuid") WHERE "server_uuid" IS NULL;
    ALTER TABLE "deploy_targets" ALTER COLUMN "server_uuid" SET NOT NULL;
    ALTER TABLE "deploy_targets" DROP COLUMN IF EXISTS "default_server_uuid", DROP COLUMN IF EXISTS "preview_server_uuid", DROP COLUMN IF EXISTS "preview_environment_name", DROP COLUMN IF EXISTS "preview_wildcard_domain", DROP COLUMN IF EXISTS "production_server_uuid", DROP COLUMN IF EXISTS "production_environment_name", DROP COLUMN IF EXISTS "public_git_enabled", DROP COLUMN IF EXISTS "github_app_enabled", DROP COLUMN IF EXISTS "deploy_key_enabled", DROP COLUMN IF EXISTS "public_registry_pull_enabled", DROP COLUMN IF EXISTS "ghcr_enabled", DROP COLUMN IF EXISTS "ghcr_credential_uuid";
    DROP TABLE IF EXISTS "theme_packages_allowed_deployment_strategies";
    ALTER TABLE "theme_packages" DROP COLUMN IF EXISTS "deployment_strategy", DROP COLUMN IF EXISTS "registry_provider", DROP COLUMN IF EXISTS "registry_image_repository", DROP COLUMN IF EXISTS "registry_visibility";
    DROP TYPE IF EXISTS "enum_theme_packages_registry_visibility"; DROP TYPE IF EXISTS "enum_theme_packages_registry_provider"; DROP TYPE IF EXISTS "enum_theme_packages_allowed_deployment_strategies"; DROP TYPE IF EXISTS "enum_theme_packages_deployment_strategy";
  `)
}
