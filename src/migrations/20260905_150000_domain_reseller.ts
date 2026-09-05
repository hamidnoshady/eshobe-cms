import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_domain_reseller_products_currency" AS ENUM('IRT', 'IRR', 'USD', 'EUR');
  CREATE TYPE "public"."enum_reseller_domains_state" AS ENUM('requested', 'providerAccepted', 'active', 'failed', 'external', 'cancelled');
  CREATE TYPE "public"."enum_reseller_domain_operations_operation" AS ENUM('register', 'transfer', 'renew');
  CREATE TYPE "public"."enum_reseller_domain_operations_status" AS ENUM('submitting', 'providerAccepted', 'failed', 'cancelled');
  CREATE TYPE "public"."enum_reseller_domain_operations_currency" AS ENUM('IRT', 'IRR', 'USD', 'EUR');
  CREATE TYPE "public"."enum_reseller_domain_operations_payment_state" AS ENUM('pendingIntegration');
  CREATE TYPE "public"."enum_reseller_domain_events_operation" AS ENUM('register', 'transfer', 'renew', 'nameserversGet', 'nameserversUpdate', 'lockGet', 'lockUpdate', 'transferCodeGet', 'childNameserverAdd', 'childNameserverUpdate', 'childNameserverRemove', 'irnicContactGet', 'transferValidate', 'whoisGet', 'whoisUpdate');
  CREATE TABLE "domain_reseller_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tld" varchar NOT NULL,
	"enabled" boolean DEFAULT true,
	"currency" "enum_domain_reseller_products_currency" DEFAULT 'IRT' NOT NULL,
	"registration_cost" numeric NOT NULL,
	"transfer_cost" numeric NOT NULL,
	"renewal_cost" numeric NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "reseller_domains_nameservers" (
	"_order" integer NOT NULL,
	"_parent_id" uuid NOT NULL,
	"id" varchar PRIMARY KEY NOT NULL,
	"hostname" varchar NOT NULL
  );

  CREATE TABLE "reseller_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"domain" varchar NOT NULL,
	"tld" varchar,
	"state" "enum_reseller_domains_state" DEFAULT 'requested' NOT NULL,
	"registration_contact" jsonb,
	"contacts" jsonb,
	"irnic_handles" jsonb,
	"custom_fields" jsonb,
	"provider_last_seen_at" timestamp(3) with time zone,
	"provider_note" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "reseller_domain_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"domain_id" uuid NOT NULL,
	"operation" "enum_reseller_domain_operations_operation" NOT NULL,
	"status" "enum_reseller_domain_operations_status" DEFAULT 'submitting' NOT NULL,
	"period" numeric NOT NULL,
	"catalogue_cost" numeric NOT NULL,
	"margin_percentage" numeric NOT NULL,
	"quote_amount" numeric NOT NULL,
	"currency" "enum_reseller_domain_operations_currency" NOT NULL,
	"payment_state" "enum_reseller_domain_operations_payment_state" DEFAULT 'pendingIntegration' NOT NULL,
	"provider_submitted_at" timestamp(3) with time zone,
	"provider_responded_at" timestamp(3) with time zone,
	"safe_detail" varchar,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "reseller_domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"domain_id" uuid NOT NULL,
	"operation" "enum_reseller_domain_events_operation" NOT NULL,
	"ok" boolean DEFAULT false NOT NULL,
	"summary" varchar NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "domain_reseller" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_endpoint" varchar DEFAULT 'https://resellerarea.net/api' NOT NULL,
	"margins_registration_percent" numeric DEFAULT 0 NOT NULL,
	"margins_transfer_percent" numeric DEFAULT 0 NOT NULL,
	"margins_renewal_percent" numeric DEFAULT 0 NOT NULL,
	"credentials_api_key" varchar,
	"clear_credentials" boolean DEFAULT false,
	"credentials_summary" varchar,
	"updated_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone
  );

  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "domain_reseller_products_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "reseller_domains_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "reseller_domain_operations_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "reseller_domain_events_id" uuid;
  ALTER TABLE "reseller_domains_nameservers" ADD CONSTRAINT "reseller_domains_nameservers_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."reseller_domains"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "reseller_domains" ADD CONSTRAINT "reseller_domains_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reseller_domain_operations" ADD CONSTRAINT "reseller_domain_operations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reseller_domain_operations" ADD CONSTRAINT "reseller_domain_operations_domain_id_reseller_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."reseller_domains"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reseller_domain_events" ADD CONSTRAINT "reseller_domain_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "reseller_domain_events" ADD CONSTRAINT "reseller_domain_events_domain_id_reseller_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."reseller_domains"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "domain_reseller_products_tld_idx" ON "domain_reseller_products" USING btree ("tld");
  CREATE INDEX "domain_reseller_products_updated_at_idx" ON "domain_reseller_products" USING btree ("updated_at");
  CREATE INDEX "domain_reseller_products_created_at_idx" ON "domain_reseller_products" USING btree ("created_at");
  CREATE INDEX "reseller_domains_nameservers_order_idx" ON "reseller_domains_nameservers" USING btree ("_order");
  CREATE INDEX "reseller_domains_nameservers_parent_id_idx" ON "reseller_domains_nameservers" USING btree ("_parent_id");
  CREATE INDEX "reseller_domains_site_idx" ON "reseller_domains" USING btree ("site_id");
  CREATE UNIQUE INDEX "reseller_domains_domain_idx" ON "reseller_domains" USING btree ("domain");
  CREATE INDEX "reseller_domains_state_idx" ON "reseller_domains" USING btree ("state");
  CREATE INDEX "reseller_domains_updated_at_idx" ON "reseller_domains" USING btree ("updated_at");
  CREATE INDEX "reseller_domains_created_at_idx" ON "reseller_domains" USING btree ("created_at");
  CREATE INDEX "reseller_domain_operations_site_idx" ON "reseller_domain_operations" USING btree ("site_id");
  CREATE INDEX "reseller_domain_operations_domain_idx" ON "reseller_domain_operations" USING btree ("domain_id");
  CREATE INDEX "reseller_domain_operations_operation_idx" ON "reseller_domain_operations" USING btree ("operation");
  CREATE INDEX "reseller_domain_operations_status_idx" ON "reseller_domain_operations" USING btree ("status");
  CREATE INDEX "reseller_domain_operations_updated_at_idx" ON "reseller_domain_operations" USING btree ("updated_at");
  CREATE INDEX "reseller_domain_operations_created_at_idx" ON "reseller_domain_operations" USING btree ("created_at");
  CREATE INDEX "reseller_domain_events_site_idx" ON "reseller_domain_events" USING btree ("site_id");
  CREATE INDEX "reseller_domain_events_domain_idx" ON "reseller_domain_events" USING btree ("domain_id");
  CREATE INDEX "reseller_domain_events_updated_at_idx" ON "reseller_domain_events" USING btree ("updated_at");
  CREATE INDEX "reseller_domain_events_created_at_idx" ON "reseller_domain_events" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_domain_reseller_products_fk" FOREIGN KEY ("domain_reseller_products_id") REFERENCES "public"."domain_reseller_products"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_reseller_domains_fk" FOREIGN KEY ("reseller_domains_id") REFERENCES "public"."reseller_domains"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_reseller_domain_operations_fk" FOREIGN KEY ("reseller_domain_operations_id") REFERENCES "public"."reseller_domain_operations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_reseller_domain_events_fk" FOREIGN KEY ("reseller_domain_events_id") REFERENCES "public"."reseller_domain_events"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_domain_reseller_products_i_idx" ON "payload_locked_documents_rels" USING btree ("domain_reseller_products_id");
  CREATE INDEX "payload_locked_documents_rels_reseller_domains_id_idx" ON "payload_locked_documents_rels" USING btree ("reseller_domains_id");
  CREATE INDEX "payload_locked_documents_rels_reseller_domain_operations_idx" ON "payload_locked_documents_rels" USING btree ("reseller_domain_operations_id");
  CREATE INDEX "payload_locked_documents_rels_reseller_domain_events_id_idx" ON "payload_locked_documents_rels" USING btree ("reseller_domain_events_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "domain_reseller_products" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "reseller_domains_nameservers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "reseller_domains" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "reseller_domain_operations" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "reseller_domain_events" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "domain_reseller" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "domain_reseller_products" CASCADE;
  DROP TABLE "reseller_domains_nameservers" CASCADE;
  DROP TABLE "reseller_domains" CASCADE;
  DROP TABLE "reseller_domain_operations" CASCADE;
  DROP TABLE "reseller_domain_events" CASCADE;
  DROP TABLE "domain_reseller" CASCADE;
  -- The four tables above are dropped with CASCADE, which may already have removed
  -- these lock-table constraints. IF EXISTS keeps down atomic and retry-safe.
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_domain_reseller_products_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_reseller_domains_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_reseller_domain_operations_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_reseller_domain_events_fk";

  DROP INDEX "payload_locked_documents_rels_domain_reseller_products_i_idx";
  DROP INDEX "payload_locked_documents_rels_reseller_domains_id_idx";
  DROP INDEX "payload_locked_documents_rels_reseller_domain_operations_idx";
  DROP INDEX "payload_locked_documents_rels_reseller_domain_events_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "domain_reseller_products_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "reseller_domains_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "reseller_domain_operations_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "reseller_domain_events_id";
  DROP TYPE "public"."enum_domain_reseller_products_currency";
  DROP TYPE "public"."enum_reseller_domains_state";
  DROP TYPE "public"."enum_reseller_domain_operations_operation";
  DROP TYPE "public"."enum_reseller_domain_operations_status";
  DROP TYPE "public"."enum_reseller_domain_operations_currency";
  DROP TYPE "public"."enum_reseller_domain_operations_payment_state";
  DROP TYPE "public"."enum_reseller_domain_events_operation";`)
}
