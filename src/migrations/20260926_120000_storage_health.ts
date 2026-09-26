import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_storage_connections_provider" AS ENUM('arvancloud', 'aws', 'cloudflare_r2', 'minio', 'wasabi', 'digitalocean', 'custom');
  CREATE TYPE "public"."enum_storage_connections_storage_mode" AS ENUM('local', 'object_storage', 'object_storage_with_local_mirror');
  CREATE TYPE "public"."enum_storage_connections_health_status" AS ENUM('unknown', 'testing', 'healthy', 'degraded', 'failed', 'retest_required', 'disabled');
  CREATE TYPE "public"."enum_storage_connections_last_error_category" AS ENUM('NETWORK', 'TLS', 'TIMEOUT', 'AUTHENTICATION', 'BUCKET_NOT_FOUND', 'PERMISSION', 'READ_FAILED', 'WRITE_FAILED', 'DELETE_FAILED', 'PROVIDER', 'CONFIGURATION', 'UNKNOWN');

  ALTER TABLE "storage_connections" ADD COLUMN "provider" "enum_storage_connections_provider" DEFAULT 'arvancloud';
  ALTER TABLE "storage_connections" ADD COLUMN "storage_mode" "enum_storage_connections_storage_mode" DEFAULT 'object_storage_with_local_mirror';
  ALTER TABLE "storage_connections" ADD COLUMN "health_status" "enum_storage_connections_health_status" DEFAULT 'unknown';
  ALTER TABLE "storage_connections" ADD COLUMN "last_checked_at" timestamp(3) with time zone;
  ALTER TABLE "storage_connections" ADD COLUMN "last_healthy_at" timestamp(3) with time zone;
  ALTER TABLE "storage_connections" ADD COLUMN "endpoint_reachable" boolean;
  ALTER TABLE "storage_connections" ADD COLUMN "authentication_ok" boolean;
  ALTER TABLE "storage_connections" ADD COLUMN "bucket_accessible" boolean;
  ALTER TABLE "storage_connections" ADD COLUMN "write_access_ok" boolean;
  ALTER TABLE "storage_connections" ADD COLUMN "read_access_ok" boolean;
  ALTER TABLE "storage_connections" ADD COLUMN "delete_access_ok" boolean;
  ALTER TABLE "storage_connections" ADD COLUMN "latency_ms" numeric;
  ALTER TABLE "storage_connections" ADD COLUMN "last_error_code" varchar;
  ALTER TABLE "storage_connections" ADD COLUMN "last_error_category" "enum_storage_connections_last_error_category";
  ALTER TABLE "storage_connections" ADD COLUMN "last_error_message" varchar;

  UPDATE "storage_connections" SET "provider" = 'arvancloud' WHERE "provider" IS NULL;
  UPDATE "storage_connections" SET "health_status" = 'healthy' WHERE "last_self_test_ok" = true;
  UPDATE "storage_connections" SET "health_status" = 'failed' WHERE "last_self_test_at" IS NOT NULL AND "last_self_test_ok" IS NOT TRUE;
  UPDATE "storage_connections" SET "last_checked_at" = "last_self_test_at" WHERE "last_self_test_at" IS NOT NULL;
  UPDATE "storage_connections" SET "last_healthy_at" = "last_self_test_at" WHERE "last_self_test_ok" = true;

  ALTER TABLE "storage_connections" ALTER COLUMN "enabled" SET DEFAULT false;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "last_error_message";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "last_error_category";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "last_error_code";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "latency_ms";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "delete_access_ok";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "read_access_ok";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "write_access_ok";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "bucket_accessible";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "authentication_ok";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "endpoint_reachable";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "last_healthy_at";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "last_checked_at";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "health_status";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "storage_mode";
  ALTER TABLE "storage_connections" DROP COLUMN IF EXISTS "provider";

  DROP TYPE IF EXISTS "public"."enum_storage_connections_last_error_category";
  DROP TYPE IF EXISTS "public"."enum_storage_connections_health_status";
  DROP TYPE IF EXISTS "public"."enum_storage_connections_storage_mode";
  DROP TYPE IF EXISTS "public"."enum_storage_connections_provider";

  ALTER TABLE "storage_connections" ALTER COLUMN "enabled" SET DEFAULT true;
  `)
}
