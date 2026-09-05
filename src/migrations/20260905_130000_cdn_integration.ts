import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_cdn_zones_dns_records_type" AS ENUM('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA');
  CREATE TYPE "public"."enum_cdn_zones_security_rules_kind" AS ENUM('firewall', 'waf');
  CREATE TYPE "public"."enum_cdn_zones_security_rules_action" AS ENUM('block', 'challenge', 'log', 'skip');
  CREATE TYPE "public"."enum_cdn_zones_provider" AS ENUM('arvancloud', 'cloudflare');
  CREATE TYPE "public"."enum_cdn_zones_arvan_domain_mode" AS ENUM('full', 'partial');
  CREATE TYPE "public"."enum_cdn_zones_ssl_mode" AS ENUM('flexible', 'full', 'strict');
  CREATE TYPE "public"."enum_cdn_zones_ssl_minimum_tls" AS ENUM('1.0', '1.1', '1.2', '1.3');
  CREATE TYPE "public"."enum_cdn_zones_cache_mode" AS ENUM('respect-origin', 'static-assets');
  CREATE TYPE "public"."enum_cdn_zones_security_security_level" AS ENUM('off', 'low', 'medium', 'high', 'under_attack');
  CREATE TYPE "public"."enum_cdn_zones_security_waf_mode" AS ENUM('off', 'detect', 'protect');
  CREATE TYPE "public"."enum_cdn_zones_security_ddos_mode" AS ENUM('off', 'cookie', 'javascript', 'recaptcha');
  CREATE TYPE "public"."enum_cdn_events_operation" AS ENUM('sync', 'purge');
  CREATE TABLE "cdn_zones_dns_records" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"type" "enum_cdn_zones_dns_records_type" DEFAULT 'A' NOT NULL,
  	"name" varchar NOT NULL,
  	"content" varchar NOT NULL,
  	"ttl" numeric DEFAULT 1,
  	"priority" numeric,
  	"proxied" boolean DEFAULT false,
  	"provider_record_id" varchar
  );
  
  CREATE TABLE "cdn_zones_security_rules" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"kind" "enum_cdn_zones_security_rules_kind" DEFAULT 'firewall' NOT NULL,
  	"description" varchar,
  	"expression" varchar NOT NULL,
  	"action" "enum_cdn_zones_security_rules_action" DEFAULT 'block' NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"provider_rule_id" varchar
  );
  
  CREATE TABLE "cdn_zones_provider_nameservers" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"hostname" varchar
  );
  
  CREATE TABLE "cdn_zones" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"provider" "enum_cdn_zones_provider" NOT NULL,
  	"zone_name" varchar NOT NULL,
  	"provider_zone_key" varchar,
  	"active" boolean DEFAULT false,
  	"provision_if_missing" boolean DEFAULT false,
  	"cloudflare_account_id" varchar,
  	"arvan_domain_mode" "enum_cdn_zones_arvan_domain_mode" DEFAULT 'full',
  	"arvan_plan_level" varchar,
  	"credentials_api_token" varchar,
  	"clear_credentials" boolean DEFAULT false,
  	"credentials_summary" varchar,
  	"ssl_mode" "enum_cdn_zones_ssl_mode" DEFAULT 'strict',
  	"ssl_minimum_tls" "enum_cdn_zones_ssl_minimum_tls" DEFAULT '1.2',
  	"ssl_tls13" boolean DEFAULT true,
  	"ssl_always_use_https" boolean DEFAULT true,
  	"hsts_enabled" boolean DEFAULT false,
  	"hsts_max_age" numeric DEFAULT 15552000,
  	"hsts_include_subdomains" boolean DEFAULT false,
  	"hsts_preload" boolean DEFAULT false,
  	"cache_mode" "enum_cdn_zones_cache_mode" DEFAULT 'respect-origin',
  	"cache_edge_ttl" numeric,
  	"cache_browser_ttl" numeric,
  	"cache_ignore_set_cookie" boolean DEFAULT false,
  	"cache_development_mode" boolean DEFAULT false,
  	"cache_always_online" boolean DEFAULT false,
  	"security_security_level" "enum_cdn_zones_security_security_level" DEFAULT 'medium',
  	"security_waf_mode" "enum_cdn_zones_security_waf_mode" DEFAULT 'detect',
  	"security_ddos_mode" "enum_cdn_zones_security_ddos_mode" DEFAULT 'off',
  	"capabilities_advanced_cache" boolean DEFAULT false,
  	"capabilities_waf_custom_rules" boolean DEFAULT false,
  	"capabilities_rate_limiting" boolean DEFAULT false,
  	"provider_plan" varchar,
  	"provider_zone_id" varchar,
  	"provider_status" varchar,
  	"last_sync_ok" boolean,
  	"last_sync_at" timestamp(3) with time zone,
  	"last_sync_detail" varchar,
  	"last_purge_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "cdn_events" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"zone_id" uuid,
  	"operation" "enum_cdn_events_operation" NOT NULL,
  	"ok" boolean DEFAULT false NOT NULL,
  	"summary" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "sites_domains" ALTER COLUMN "verified" SET DEFAULT false;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cdn_zones_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cdn_events_id" uuid;
  ALTER TABLE "cdn_zones_dns_records" ADD CONSTRAINT "cdn_zones_dns_records_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cdn_zones"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cdn_zones_security_rules" ADD CONSTRAINT "cdn_zones_security_rules_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cdn_zones"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cdn_zones_provider_nameservers" ADD CONSTRAINT "cdn_zones_provider_nameservers_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cdn_zones"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cdn_zones" ADD CONSTRAINT "cdn_zones_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cdn_events" ADD CONSTRAINT "cdn_events_zone_id_cdn_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."cdn_zones"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "cdn_zones_dns_records_order_idx" ON "cdn_zones_dns_records" USING btree ("_order");
  CREATE INDEX "cdn_zones_dns_records_parent_id_idx" ON "cdn_zones_dns_records" USING btree ("_parent_id");
  CREATE INDEX "cdn_zones_security_rules_order_idx" ON "cdn_zones_security_rules" USING btree ("_order");
  CREATE INDEX "cdn_zones_security_rules_parent_id_idx" ON "cdn_zones_security_rules" USING btree ("_parent_id");
  CREATE INDEX "cdn_zones_provider_nameservers_order_idx" ON "cdn_zones_provider_nameservers" USING btree ("_order");
  CREATE INDEX "cdn_zones_provider_nameservers_parent_id_idx" ON "cdn_zones_provider_nameservers" USING btree ("_parent_id");
  CREATE INDEX "cdn_zones_site_idx" ON "cdn_zones" USING btree ("site_id");
  CREATE UNIQUE INDEX "cdn_zones_zone_name_idx" ON "cdn_zones" USING btree ("zone_name");
  CREATE UNIQUE INDEX "cdn_zones_provider_zone_key_idx" ON "cdn_zones" USING btree ("provider_zone_key");
  CREATE INDEX "cdn_zones_updated_at_idx" ON "cdn_zones" USING btree ("updated_at");
  CREATE INDEX "cdn_zones_created_at_idx" ON "cdn_zones" USING btree ("created_at");
  CREATE INDEX "cdn_events_zone_idx" ON "cdn_events" USING btree ("zone_id");
  CREATE INDEX "cdn_events_updated_at_idx" ON "cdn_events" USING btree ("updated_at");
  CREATE INDEX "cdn_events_created_at_idx" ON "cdn_events" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cdn_zones_fk" FOREIGN KEY ("cdn_zones_id") REFERENCES "public"."cdn_zones"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cdn_events_fk" FOREIGN KEY ("cdn_events_id") REFERENCES "public"."cdn_events"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_cdn_zones_id_idx" ON "payload_locked_documents_rels" USING btree ("cdn_zones_id");
  CREATE INDEX "payload_locked_documents_rels_cdn_events_id_idx" ON "payload_locked_documents_rels" USING btree ("cdn_events_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cdn_zones_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cdn_events_fk";
  DROP INDEX "payload_locked_documents_rels_cdn_zones_id_idx";
  DROP INDEX "payload_locked_documents_rels_cdn_events_id_idx";
  ALTER TABLE "cdn_zones_dns_records" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cdn_zones_security_rules" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cdn_zones_provider_nameservers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cdn_zones" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cdn_events" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "cdn_zones_dns_records";
  DROP TABLE "cdn_zones_security_rules";
  DROP TABLE "cdn_zones_provider_nameservers";
  DROP TABLE "cdn_events";
  DROP TABLE "cdn_zones";
  ALTER TABLE "sites_domains" ALTER COLUMN "verified" SET DEFAULT false;
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cdn_zones_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cdn_events_id";
  DROP TYPE "public"."enum_cdn_zones_dns_records_type";
  DROP TYPE "public"."enum_cdn_zones_security_rules_kind";
  DROP TYPE "public"."enum_cdn_zones_security_rules_action";
  DROP TYPE "public"."enum_cdn_zones_provider";
  DROP TYPE "public"."enum_cdn_zones_arvan_domain_mode";
  DROP TYPE "public"."enum_cdn_zones_ssl_mode";
  DROP TYPE "public"."enum_cdn_zones_ssl_minimum_tls";
  DROP TYPE "public"."enum_cdn_zones_cache_mode";
  DROP TYPE "public"."enum_cdn_zones_security_security_level";
  DROP TYPE "public"."enum_cdn_zones_security_waf_mode";
  DROP TYPE "public"."enum_cdn_zones_security_ddos_mode";
  DROP TYPE "public"."enum_cdn_events_operation";`)
}
