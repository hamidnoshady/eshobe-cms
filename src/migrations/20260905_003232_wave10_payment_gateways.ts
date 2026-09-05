import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_orders_payment_mode" AS ENUM('live', 'sandbox');
  CREATE TYPE "public"."enum_payment_gateways_gateway" AS ENUM('digipay', 'snappPay', 'torobPay', 'zarinpal');
  CREATE TYPE "public"."enum_payment_gateways_mode" AS ENUM('live', 'sandbox');
  CREATE TYPE "public"."enum_payment_gateways_credentials_preferred_gateway" AS ENUM('none', '0', '2');
  CREATE TYPE "public"."enum_payment_gateways_credentials_ticket_type" AS ENUM('11', '5', '13');
  CREATE TYPE "public"."enum_payment_gateways_credentials_basket_category_id" AS ENUM('none', 'Mobile', 'laptop', 'tablet', 'gameconsole');
  CREATE TYPE "public"."enum_payment_gateways_credentials_basket_product_type" AS ENUM('1', '2', '3', '4');
  CREATE TYPE "public"."enum_payment_gateways_credentials_amount_unit" AS ENUM('site', 'IRR', 'IRT');
  CREATE TYPE "public"."enum_payments_allowed_gateways" AS ENUM('digipay', 'snappPay', 'torobPay', 'zarinpal');
  ALTER TYPE "public"."enum_orders_payment_provider" ADD VALUE 'digipay';
  ALTER TYPE "public"."enum_orders_payment_provider" ADD VALUE 'snappPay';
  ALTER TYPE "public"."enum_orders_payment_provider" ADD VALUE 'torobPay';
  ALTER TYPE "public"."enum_orders_payment_provider" ADD VALUE 'zarinpal';
  ALTER TYPE "public"."enum_store_payment_provider" ADD VALUE 'digipay';
  ALTER TYPE "public"."enum_store_payment_provider" ADD VALUE 'snappPay';
  ALTER TYPE "public"."enum_store_payment_provider" ADD VALUE 'torobPay';
  ALTER TYPE "public"."enum_store_payment_provider" ADD VALUE 'zarinpal';
  CREATE TABLE "payment_gateways" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"title" varchar,
  	"gateway" "enum_payment_gateways_gateway" NOT NULL,
  	"mode" "enum_payment_gateways_mode" DEFAULT 'live' NOT NULL,
  	"enabled" boolean DEFAULT false,
  	"priority" numeric DEFAULT 100 NOT NULL,
  	"min_amount" numeric,
  	"max_amount" numeric,
  	"credentials_merchant_id" varchar,
  	"credentials_referrer_id" varchar,
  	"credentials_username" varchar,
  	"credentials_password" varchar,
  	"credentials_client_id" varchar,
  	"credentials_client_secret" varchar,
  	"credentials_token" varchar,
  	"credentials_base_url" varchar,
  	"credentials_preferred_gateway" "enum_payment_gateways_credentials_preferred_gateway",
  	"credentials_ticket_type" "enum_payment_gateways_credentials_ticket_type",
  	"credentials_basket_category_id" "enum_payment_gateways_credentials_basket_category_id",
  	"credentials_basket_product_type" "enum_payment_gateways_credentials_basket_product_type",
  	"credentials_seller_id" varchar,
  	"credentials_supplier_id" varchar,
  	"credentials_basket_brand" varchar,
  	"credentials_pay_page_url" varchar,
  	"credentials_min_amount_rial" varchar,
  	"credentials_commission_type" varchar,
  	"credentials_create_path" varchar,
  	"credentials_verify_path" varchar,
  	"credentials_cancel_path" varchar,
  	"credentials_amount_unit" "enum_payment_gateways_credentials_amount_unit",
  	"clear_credentials" boolean DEFAULT false,
  	"credentials_summary" varchar,
  	"credentials_updated_at" timestamp(3) with time zone,
  	"self_test_ok" boolean,
  	"self_test_detail" varchar,
  	"self_test_at" timestamp(3) with time zone,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payment_gateways_locales" (
  	"display_name" varchar,
  	"id" serial PRIMARY KEY NOT NULL,
  	"_locale" "_locales" NOT NULL,
  	"_parent_id" uuid NOT NULL
  );
  
  CREATE TABLE "payments_allowed_gateways" (
  	"order" integer NOT NULL,
  	"parent_id" uuid NOT NULL,
  	"value" "enum_payments_allowed_gateways",
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
  );
  
  CREATE TABLE "payments" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"module_enabled" boolean DEFAULT true NOT NULL,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  -- NOT Wave 10. These four columns and the two indexes at the end of this statement are
  -- pre-existing drift: src/collections/Products.ts localized its slug (and added
  -- generateSlug) after 20260831_181044_add_api_keys, and no migration was generated for
  -- it, so the last snapshot does not know about them. migrate:create diffs against that
  -- snapshot, which is why they surface here.
  --
  -- They are carried in this migration rather than split into their own because a split
  -- would need its own hand-written snapshot JSON, and a wrong snapshot is worse than a
  -- migration with two clearly-labelled jobs: every later migrate:create would diff
  -- against it. A production database that only ever ran migrations is missing these
  -- columns today, so applying them is a fix, not a side effect.
  --
  -- No backticks or dollar-braces in these comments: the SQL is inside a JS template
  -- literal, so either would end the string.
  ALTER TABLE "products_locales" ADD COLUMN "generate_slug" boolean DEFAULT true;
  ALTER TABLE "products_locales" ADD COLUMN "slug" varchar;
  ALTER TABLE "_products_v_locales" ADD COLUMN "version_generate_slug" boolean DEFAULT true;
  ALTER TABLE "_products_v_locales" ADD COLUMN "version_slug" varchar;
  ALTER TABLE "orders" ADD COLUMN "payment_mode" "enum_orders_payment_mode";
  ALTER TABLE "orders" ADD COLUMN "payment_gateway_data" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "payment_gateways_id" uuid;
  ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payment_gateways_locales" ADD CONSTRAINT "payment_gateways_locales_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."payment_gateways"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payments_allowed_gateways" ADD CONSTRAINT "payments_allowed_gateways_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payment_gateways_site_idx" ON "payment_gateways" USING btree ("site_id");
  CREATE INDEX "payment_gateways_updated_at_idx" ON "payment_gateways" USING btree ("updated_at");
  CREATE INDEX "payment_gateways_created_at_idx" ON "payment_gateways" USING btree ("created_at");
  CREATE UNIQUE INDEX "payment_gateways_locales_locale_parent_id_unique" ON "payment_gateways_locales" USING btree ("_locale","_parent_id");
  CREATE INDEX "payments_allowed_gateways_order_idx" ON "payments_allowed_gateways" USING btree ("order");
  CREATE INDEX "payments_allowed_gateways_parent_idx" ON "payments_allowed_gateways" USING btree ("parent_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_payment_gateways_fk" FOREIGN KEY ("payment_gateways_id") REFERENCES "public"."payment_gateways"("id") ON DELETE cascade ON UPDATE no action;
  -- Also pre-existing drift; see the note above the products_locales columns.
  CREATE INDEX "products_slug_idx" ON "products_locales" USING btree ("slug","_locale");
  CREATE INDEX "_products_v_version_version_slug_idx" ON "_products_v_locales" USING btree ("version_slug","_locale");
  CREATE INDEX "payload_locked_documents_rels_payment_gateways_id_idx" ON "payload_locked_documents_rels" USING btree ("payment_gateways_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Hand-patched, same bug class as `20260831_181044_add_api_keys.ts` and
  // `20260827_143142_wave7_store.ts` (see CLAUDE.md): `DROP TABLE ... CASCADE` already
  // removes `payload_locked_documents_rels_payment_gateways_fk` along with the table, so
  // the generated `DROP CONSTRAINT` — which has no `IF EXISTS` — throws and leaves `down`
  // half-applied. The generated statement is kept, made idempotent.
  await db.execute(sql`
   ALTER TABLE "payment_gateways" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payment_gateways_locales" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payments_allowed_gateways" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payments" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "payment_gateways" CASCADE;
  DROP TABLE "payment_gateways_locales" CASCADE;
  DROP TABLE "payments_allowed_gateways" CASCADE;
  DROP TABLE "payments" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_payment_gateways_fk";
  
  ALTER TABLE "orders" ALTER COLUMN "payment_provider" SET DATA TYPE text;
  DROP TYPE "public"."enum_orders_payment_provider";
  CREATE TYPE "public"."enum_orders_payment_provider" AS ENUM('bank', 'http');
  ALTER TABLE "orders" ALTER COLUMN "payment_provider" SET DATA TYPE "public"."enum_orders_payment_provider" USING "payment_provider"::"public"."enum_orders_payment_provider";
  ALTER TABLE "store" ALTER COLUMN "payment_provider" SET DATA TYPE text;
  ALTER TABLE "store" ALTER COLUMN "payment_provider" SET DEFAULT 'bank'::text;
  DROP TYPE "public"."enum_store_payment_provider";
  CREATE TYPE "public"."enum_store_payment_provider" AS ENUM('bank', 'http');
  ALTER TABLE "store" ALTER COLUMN "payment_provider" SET DEFAULT 'bank'::"public"."enum_store_payment_provider";
  ALTER TABLE "store" ALTER COLUMN "payment_provider" SET DATA TYPE "public"."enum_store_payment_provider" USING "payment_provider"::"public"."enum_store_payment_provider";
  DROP INDEX "payload_locked_documents_rels_payment_gateways_id_idx";
  -- The pre-existing products_locales drift that up carries along is deliberately NOT
  -- undone here. Rolling back Wave 10 must not drop a localized product slug column that
  -- this migration did not introduce and that live product rows are using; a down that
  -- destroys unrelated customer data is worse than a down that leaves two extra columns.
  -- Drop them by hand if the slug localization is ever genuinely reverted.
  ALTER TABLE "orders" DROP COLUMN "payment_mode";
  ALTER TABLE "orders" DROP COLUMN "payment_gateway_data";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "payment_gateways_id";
  DROP TYPE "public"."enum_orders_payment_mode";
  DROP TYPE "public"."enum_payment_gateways_gateway";
  DROP TYPE "public"."enum_payment_gateways_mode";
  DROP TYPE "public"."enum_payment_gateways_credentials_preferred_gateway";
  DROP TYPE "public"."enum_payment_gateways_credentials_ticket_type";
  DROP TYPE "public"."enum_payment_gateways_credentials_basket_category_id";
  DROP TYPE "public"."enum_payment_gateways_credentials_basket_product_type";
  DROP TYPE "public"."enum_payment_gateways_credentials_amount_unit";
  DROP TYPE "public"."enum_payments_allowed_gateways";`)
}
