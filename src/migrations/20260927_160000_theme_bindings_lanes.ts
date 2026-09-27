import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_theme_bindings_lane" AS ENUM('preview', 'production');
  CREATE TYPE "public"."enum_theme_bindings_state" AS ENUM('active', 'provisioning', 'stopped', 'conflict');
  CREATE TYPE "public"."enum_site_deployments_lane" AS ENUM('preview', 'production');

  ALTER TABLE "deploy_targets" ADD COLUMN IF NOT EXISTS "preview_project_uuid" varchar;
  ALTER TABLE "deploy_targets" ADD COLUMN IF NOT EXISTS "production_project_uuid" varchar;

  UPDATE "deploy_targets"
  SET "production_project_uuid" = "project_uuid"
  WHERE "production_project_uuid" IS NULL AND "project_uuid" IS NOT NULL;

  ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "assigned_theme_package_id" uuid;
  ALTER TABLE "sites" ADD CONSTRAINT "sites_assigned_theme_package_id_theme_packages_id_fk"
    FOREIGN KEY ("assigned_theme_package_id") REFERENCES "public"."theme_packages"("id") ON DELETE set null ON UPDATE no action;

  CREATE TABLE "theme_bindings" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"binding_key" varchar NOT NULL,
  	"theme_package_id" uuid NOT NULL,
  	"lane" "enum_theme_bindings_lane" NOT NULL,
  	"target_id" uuid NOT NULL,
  	"app_uuid" varchar,
  	"app_name" varchar,
  	"application_hostname" varchar,
  	"coolify_project_uuid" varchar NOT NULL,
  	"server_uuid" varchar NOT NULL,
  	"environment_name" varchar DEFAULT 'production' NOT NULL,
  	"state" "enum_theme_bindings_state" DEFAULT 'active' NOT NULL,
  	"conflict_detail" varchar,
  	"provisioning_deployment_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"site_id" uuid NOT NULL
  );

  ALTER TABLE "theme_bindings" ADD CONSTRAINT "theme_bindings_theme_package_id_theme_packages_id_fk"
    FOREIGN KEY ("theme_package_id") REFERENCES "public"."theme_packages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "theme_bindings" ADD CONSTRAINT "theme_bindings_target_id_deploy_targets_id_fk"
    FOREIGN KEY ("target_id") REFERENCES "public"."deploy_targets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "theme_bindings" ADD CONSTRAINT "theme_bindings_provisioning_deployment_id_site_deployments_id_fk"
    FOREIGN KEY ("provisioning_deployment_id") REFERENCES "public"."site_deployments"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "theme_bindings" ADD CONSTRAINT "theme_bindings_site_id_sites_id_fk"
    FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;

  CREATE UNIQUE INDEX "theme_bindings_binding_key_idx" ON "theme_bindings" USING btree ("binding_key");
  CREATE INDEX "theme_bindings_site_idx" ON "theme_bindings" USING btree ("site_id");
  CREATE INDEX "theme_bindings_lane_idx" ON "theme_bindings" USING btree ("lane");

  ALTER TABLE "site_deployments" ADD COLUMN IF NOT EXISTS "lane" "enum_site_deployments_lane";
  ALTER TABLE "site_deployments" ADD COLUMN IF NOT EXISTS "theme_binding_id" uuid;
  ALTER TABLE "site_deployments" ADD CONSTRAINT "site_deployments_theme_binding_id_theme_bindings_id_fk"
    FOREIGN KEY ("theme_binding_id") REFERENCES "public"."theme_bindings"("id") ON DELETE set null ON UPDATE no action;

  UPDATE "site_deployments"
  SET "lane" = CASE
    WHEN "domain_mode" = 'preview' THEN 'preview'::"enum_site_deployments_lane"
    ELSE 'production'::"enum_site_deployments_lane"
  END
  WHERE "lane" IS NULL;

  ALTER TABLE "site_deployments" ALTER COLUMN "lane" SET NOT NULL;
  `)

  await db.execute(sql`
  INSERT INTO "theme_bindings" (
    "id",
    "binding_key",
    "theme_package_id",
    "lane",
    "target_id",
    "app_uuid",
    "application_hostname",
    "coolify_project_uuid",
    "server_uuid",
    "environment_name",
    "state",
    "site_id",
    "created_at",
    "updated_at"
  )
  SELECT
    gen_random_uuid(),
    sd."site_id"::text || ':' || sd."theme_package_id"::text || ':' || sd."lane"::text,
    sd."theme_package_id",
    sd."lane"::text::"enum_theme_bindings_lane",
    sd."target_id",
    sd."app_uuid",
    sd."preview_domain",
    COALESCE(dt."production_project_uuid", dt."project_uuid"),
    dt."server_uuid",
    COALESCE(dt."environment_name", 'production'),
    'active'::"enum_theme_bindings_state",
    sd."site_id",
    NOW(),
    NOW()
  FROM (
    SELECT DISTINCT ON ("site_id", "theme_package_id", "lane")
      *
    FROM "site_deployments"
    WHERE "app_uuid" IS NOT NULL AND TRIM("app_uuid") <> ''
    ORDER BY
      "site_id",
      "theme_package_id",
      "lane",
      CASE "status"
        WHEN 'live' THEN 0
        WHEN 'verifying' THEN 1
        WHEN 'building' THEN 2
        WHEN 'creating' THEN 3
        WHEN 'queued' THEN 4
        ELSE 5
      END,
      "updated_at" DESC
  ) sd
  INNER JOIN "deploy_targets" dt ON dt."id" = sd."target_id"
  ON CONFLICT ("binding_key") DO NOTHING;

  UPDATE "site_deployments" sd
  SET "theme_binding_id" = tb."id"
  FROM "theme_bindings" tb
  WHERE
    tb."binding_key" = sd."site_id"::text || ':' || sd."theme_package_id"::text || ':' || sd."lane"::text
    AND sd."theme_binding_id" IS NULL;

  UPDATE "sites" s
  SET "assigned_theme_package_id" = sd."theme_package_id"
  FROM "site_deployments" sd
  WHERE
    sd."site_id" = s."id"
    AND sd."status" = 'live'
    AND sd."domain_mode" IN ('edge', 'direct')
    AND s."assigned_theme_package_id" IS NULL;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "site_deployments" DROP CONSTRAINT IF EXISTS "site_deployments_theme_binding_id_theme_bindings_id_fk";
  ALTER TABLE "site_deployments" DROP COLUMN IF EXISTS "theme_binding_id";
  ALTER TABLE "site_deployments" DROP COLUMN IF EXISTS "lane";

  ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "sites_assigned_theme_package_id_theme_packages_id_fk";
  ALTER TABLE "sites" DROP COLUMN IF EXISTS "assigned_theme_package_id";

  DROP TABLE IF EXISTS "theme_bindings";

  ALTER TABLE "deploy_targets" DROP COLUMN IF EXISTS "preview_project_uuid";
  ALTER TABLE "deploy_targets" DROP COLUMN IF EXISTS "production_project_uuid";

  DROP TYPE IF EXISTS "enum_site_deployments_lane";
  DROP TYPE IF EXISTS "enum_theme_bindings_state";
  DROP TYPE IF EXISTS "enum_theme_bindings_lane";
  `)
}
