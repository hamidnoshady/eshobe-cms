import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Provider-native ArvanCloud origin TLS controls, per-zone origin overrides, and
 * read-only discovery / connection-test bookkeeping on `cdn_zones`.
 *
 * - `arvan_origin_https` / `arvan_origin_port` / `arvan_origin_host_header`: the
 *   typed ArvanCloud origin group. `origin_https` maps to the record-level
 *   `upstream_https` field; ArvanCloud has no zone-level `ssl.mode`, so the
 *   generic `ssl.mode` is no longer silently mapped onto its `/ssl` endpoint.
 * - `origin_target` / `origin_override_reason` / `origin_override_at`: a zone may
 *   point its proxied records at a different physical origin than the shared
 *   account's `origin_target` (multi-server deployments such as Srv1 Traefik →
 *   Srv2 theme), with an auditable reason and timestamp.
 * - `last_connection_test_*` and `last_discover_at`: read-only operational state
 *   for the staff-only `POST /api/cdn/zones/:id/test-connection` and
 *   `POST /api/cdn/zones/:id/discover` endpoints.
 *
 * Hand-written (the last Payload snapshot predates these fields). Every statement
 * is idempotent.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
      CREATE TYPE "public"."enum_cdn_zones_arvan_origin_https" AS ENUM('default', 'on', 'off');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

    ALTER TABLE "cdn_zones"
      ADD COLUMN IF NOT EXISTS "origin_target" varchar,
      ADD COLUMN IF NOT EXISTS "origin_override_reason" varchar,
      ADD COLUMN IF NOT EXISTS "origin_override_at" timestamp(3) with time zone,
      ADD COLUMN IF NOT EXISTS "arvan_origin_https" "enum_cdn_zones_arvan_origin_https" DEFAULT 'default',
      ADD COLUMN IF NOT EXISTS "arvan_origin_port" numeric,
      ADD COLUMN IF NOT EXISTS "arvan_origin_host_header" varchar,
      ADD COLUMN IF NOT EXISTS "last_connection_test_at" timestamp(3) with time zone,
      ADD COLUMN IF NOT EXISTS "last_connection_test_ok" boolean,
      ADD COLUMN IF NOT EXISTS "last_connection_test_detail" text,
      ADD COLUMN IF NOT EXISTS "last_discover_at" timestamp(3) with time zone;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "cdn_zones"
      DROP COLUMN IF EXISTS "origin_target",
      DROP COLUMN IF EXISTS "origin_override_reason",
      DROP COLUMN IF EXISTS "origin_override_at",
      DROP COLUMN IF EXISTS "arvan_origin_https",
      DROP COLUMN IF EXISTS "arvan_origin_port",
      DROP COLUMN IF EXISTS "arvan_origin_host_header",
      DROP COLUMN IF EXISTS "last_connection_test_at",
      DROP COLUMN IF EXISTS "last_connection_test_ok",
      DROP COLUMN IF EXISTS "last_connection_test_detail",
      DROP COLUMN IF EXISTS "last_discover_at";
    DROP TYPE IF EXISTS "public"."enum_cdn_zones_arvan_origin_https";
  `)
}
