import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Issue #166 — WordPress/WooCommerce Migration Center and commerce history.
 *
 * Adds the tenant-scoped migration ledger (`migration_sources`, jobs,
 * batches, mappings, records, events, errors, audits and redirect
 * inventory), dedicated store customers, coupons, expanded product
 * attributes/variations, authoritative multi-line order sub-tables, native
 * page hierarchy, taxonomy-term relationships on posts/products, the
 * `source_*` provenance columns, and the `migrationJobs` payload-job slug.
 *
 * Hand-written in the style of the recent migrations. Its DDL is the
 * catalog diff between a database dev-pushed from `main` and the same
 * database dev-pushed from this branch, so migration-only production
 * objects from earlier waves are deliberately left untouched. Statements
 * are idempotent where Postgres permits it, making a retry after a partial
 * deploy converge instead of failing on its own leftovers.
 *
 * Two pieces are intentionally stronger/more explicit than a raw schema
 * diff:
 *
 * - redirects lose their platform-global unique index and gain a
 *   `(site_id, from)` unique index, matching the per-site resolver;
 * - a pre-expansion order is backfilled with one `orders_items` row only
 *   when its stored total exactly equals `quantity * unit_price`. Rows
 *   outside that identity keep their legacy fields rather than receiving
 *   an invented discount, shipping, tax or fee breakdown.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
          create type "public"."enum__pages_v_version_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum__pages_v_version_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum__posts_v_version_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum__posts_v_version_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum__products_v_version_product_type" as enum ('simple', 'variable', 'grouped', 'external');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum__products_v_version_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum__products_v_version_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_categories_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_categories_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_coupons_discount_type" as enum ('percent', 'fixed-cart', 'fixed-product');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_coupons_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_coupons_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_customers_claim_status" as enum ('unclaimed', 'invited', 'claimed', 'disabled');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_customers_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_customers_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_customers_status" as enum ('active', 'inactive', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_media_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_media_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_batches_status" as enum ('running', 'completed', 'failed', 'paused', 'cancelled');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_errors_status" as enum ('open', 'resolved', 'ignored');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_events_level" as enum ('info', 'warning', 'error');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_jobs_control" as enum ('run', 'pause', 'cancel');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_jobs_operation" as enum ('discover', 'dry-run', 'import', 'sync', 'reconcile', 'cutover', 'rollback');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_jobs_status" as enum ('draft', 'queued', 'running', 'paused', 'blocked', 'ready', 'ready-for-cutover', 'completed', 'cancelled', 'failed', 'rolled-back');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_mappings_disposition" as enum ('supported', 'requires-mapping', 'unsupported-blocking', 'archive-only', 'excluded');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_mappings_status" as enum ('proposed', 'confirmed', 'rejected');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_records_disposition" as enum ('planned', 'imported', 'updated', 'unchanged', 'archived', 'blocked', 'error', 'deleted', 'rolled-back');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_redirects_status" as enum ('proposed', 'applied', 'unchanged', 'conflict', 'ignored', 'rolled-back');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_migration_sources_status" as enum ('untested', 'ready', 'blocked', 'error');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_orders_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_orders_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_pages_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_pages_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_posts_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_posts_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_products_product_type" as enum ('simple', 'variable', 'grouped', 'external');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_products_source_mapping_status" as enum ('manual', 'imported', 'archived', 'blocked');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
          create type "public"."enum_products_source_system" as enum ('eshobe', 'wordpress', 'woocommerce', 'other');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SEQUENCE IF NOT EXISTS "public"."_products_v_rels_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."_products_v_version_attributes_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."_products_v_version_attributes_options_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."_products_v_version_variations_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."coupons_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."coupons_rels_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."products_attributes_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."products_attributes_options_locales_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."products_rels_id_seq";
    CREATE SEQUENCE IF NOT EXISTS "public"."products_variations_locales_id_seq";
    ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE IF NOT EXISTS 'migrationJobs' BEFORE 'schedulePublish';
    ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE IF NOT EXISTS 'migrationJobs' BEFORE 'schedulePublish';
    CREATE TABLE IF NOT EXISTS "public"."_products_v_rels" (
        "id" integer not null default nextval('_products_v_rels_id_seq'::regclass),
        "order" integer,
        "parent_id" uuid not null,
        "path" character varying not null,
        "products_id" uuid,
        "media_id" uuid,
        "taxonomy_terms_id" uuid
    );
    CREATE TABLE IF NOT EXISTS "public"."_products_v_version_attributes" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" uuid not null default gen_random_uuid(),
        "key" character varying,
        "visible" boolean default true,
        "used_for_variation" boolean default false,
        "_uuid" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."_products_v_version_attributes_locales" (
        "name" character varying,
        "id" integer not null default nextval('_products_v_version_attributes_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" uuid not null
    );
    CREATE TABLE IF NOT EXISTS "public"."_products_v_version_attributes_options" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" uuid not null default gen_random_uuid(),
        "_uuid" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."_products_v_version_attributes_options_locales" (
        "value" character varying,
        "id" integer not null default nextval('_products_v_version_attributes_options_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" uuid not null
    );
    CREATE TABLE IF NOT EXISTS "public"."_products_v_version_variations" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" uuid not null default gen_random_uuid(),
        "key" character varying,
        "sku" character varying,
        "price" numeric,
        "compare_at_price" numeric,
        "track_inventory" boolean default false,
        "inventory" numeric,
        "image_id" uuid,
        "attribute_values" jsonb,
        "active" boolean default true,
        "weight" character varying,
        "source_id" character varying,
        "source_status" character varying,
        "_uuid" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."_products_v_version_variations_locales" (
        "label" character varying,
        "id" integer not null default nextval('_products_v_version_variations_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" uuid not null
    );
    CREATE TABLE IF NOT EXISTS "public"."coupons" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "code" character varying not null,
        "discount_type" enum_coupons_discount_type not null default 'fixed-cart'::enum_coupons_discount_type,
        "amount" numeric not null,
        "minimum_amount" numeric,
        "maximum_amount" numeric,
        "usage_limit" numeric,
        "usage_limit_per_user" numeric,
        "usage_count" numeric default 0,
        "individual_use" boolean default false,
        "free_shipping" boolean default false,
        "starts_at" timestamp(3) with time zone,
        "expires_at" timestamp(3) with time zone,
        "active" boolean default true,
        "source_system" enum_coupons_source_system default 'eshobe'::enum_coupons_source_system,
        "source_mapping_status" enum_coupons_source_mapping_status default 'manual'::enum_coupons_source_mapping_status,
        "source_installation" character varying,
        "source_source_id" character varying,
        "source_source_type" character varying,
        "source_source_status" character varying,
        "source_source_author_id" character varying,
        "source_permalink" character varying,
        "source_modified_at" timestamp(3) with time zone,
        "source_content_hash" character varying,
        "source_raw_payload" jsonb,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."coupons_locales" (
        "description" character varying,
        "id" integer not null default nextval('coupons_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" uuid not null
    );
    CREATE TABLE IF NOT EXISTS "public"."coupons_rels" (
        "id" integer not null default nextval('coupons_rels_id_seq'::regclass),
        "order" integer,
        "parent_id" uuid not null,
        "path" character varying not null,
        "products_id" uuid
    );
    CREATE TABLE IF NOT EXISTS "public"."customers" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "email" character varying,
        "first_name" character varying,
        "last_name" character varying,
        "display_name" character varying,
        "phone" character varying,
        "username" character varying,
        "status" enum_customers_status not null default 'active'::enum_customers_status,
        "claim_status" enum_customers_claim_status not null default 'unclaimed'::enum_customers_claim_status,
        "claim_token_hash" character varying,
        "claim_expires_at" timestamp(3) with time zone,
        "invited_at" timestamp(3) with time zone,
        "claimed_at" timestamp(3) with time zone,
        "notes" character varying,
        "source_system" enum_customers_source_system default 'eshobe'::enum_customers_source_system,
        "source_mapping_status" enum_customers_source_mapping_status default 'manual'::enum_customers_source_mapping_status,
        "source_installation" character varying,
        "source_source_id" character varying,
        "source_source_type" character varying,
        "source_source_status" character varying,
        "source_source_author_id" character varying,
        "source_permalink" character varying,
        "source_modified_at" timestamp(3) with time zone,
        "source_content_hash" character varying,
        "source_raw_payload" jsonb,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."customers_addresses" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "label" character varying,
        "first_name" character varying,
        "last_name" character varying,
        "company" character varying,
        "address1" character varying,
        "address2" character varying,
        "city" character varying,
        "state" character varying,
        "postcode" character varying,
        "country" character varying,
        "phone" character varying,
        "email" character varying,
        "is_default_billing" boolean default false,
        "is_default_shipping" boolean default false
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_audits" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid,
        "source_id" uuid,
        "actor_id" uuid,
        "action" character varying not null,
        "summary" character varying not null,
        "details" jsonb,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_batches" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid not null,
        "source_id" uuid,
        "run_id" character varying not null,
        "resource" character varying not null,
        "page" numeric not null,
        "status" enum_migration_batches_status not null default 'running'::enum_migration_batches_status,
        "counts_seen" numeric default 0,
        "counts_imported" numeric default 0,
        "counts_updated" numeric default 0,
        "counts_unchanged" numeric default 0,
        "counts_archived" numeric default 0,
        "counts_blocked" numeric default 0,
        "counts_errors" numeric default 0,
        "checkpoint" jsonb,
        "started_at" timestamp(3) with time zone,
        "finished_at" timestamp(3) with time zone,
        "error" character varying,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_errors" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid,
        "batch_id" uuid,
        "source_id" uuid,
        "record_id" uuid,
        "resource" character varying,
        "source_record_id" character varying,
        "code" character varying not null,
        "message" character varying not null,
        "retryable" boolean default true,
        "attempts" numeric default 1,
        "status" enum_migration_errors_status not null default 'open'::enum_migration_errors_status,
        "details" jsonb,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_events" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid,
        "source_id" uuid,
        "event_type" character varying not null,
        "level" enum_migration_events_level not null default 'info'::enum_migration_events_level,
        "resource" character varying,
        "source_record_id" character varying,
        "message" character varying not null,
        "details" jsonb,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_jobs" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "title" character varying not null,
        "source_id" uuid not null,
        "operation" enum_migration_jobs_operation not null default 'discover'::enum_migration_jobs_operation,
        "status" enum_migration_jobs_status not null default 'draft'::enum_migration_jobs_status,
        "phase" character varying,
        "control" enum_migration_jobs_control not null default 'run'::enum_migration_jobs_control,
        "run_requested_at" timestamp(3) with time zone,
        "current_run_id" character varying,
        "locked_at" timestamp(3) with time zone,
        "lock_token" character varying,
        "settings" jsonb,
        "inventory" jsonb,
        "coverage" jsonb,
        "dry_run_report" jsonb,
        "reconciliation_report" jsonb,
        "checkpoint" jsonb,
        "summary" jsonb,
        "blockers" jsonb,
        "counts_seen" numeric default 0,
        "counts_imported" numeric default 0,
        "counts_updated" numeric default 0,
        "counts_unchanged" numeric default 0,
        "counts_archived" numeric default 0,
        "counts_blocked" numeric default 0,
        "counts_errors" numeric default 0,
        "started_at" timestamp(3) with time zone,
        "finished_at" timestamp(3) with time zone,
        "last_sync_at" timestamp(3) with time zone,
        "source_write_fence_confirmed_at" timestamp(3) with time zone,
        "cutover_at" timestamp(3) with time zone,
        "rolled_back_at" timestamp(3) with time zone,
        "last_error" character varying,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_mappings" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid not null,
        "source_id" uuid,
        "resource" character varying not null,
        "source_field" character varying,
        "destination" character varying not null,
        "disposition" enum_migration_mappings_disposition not null default 'requires-mapping'::enum_migration_mappings_disposition,
        "status" enum_migration_mappings_status not null default 'proposed'::enum_migration_mappings_status,
        "transform" jsonb,
        "reason" character varying,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_records" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid,
        "source_id" uuid not null,
        "idempotency_key" character varying not null,
        "installation" character varying not null,
        "resource" character varying not null,
        "source_record_id" character varying not null,
        "source_slug" character varying,
        "source_permalink" character varying,
        "source_modified_at" timestamp(3) with time zone,
        "content_hash" character varying,
        "destination_collection" character varying,
        "destination_id" character varying,
        "disposition" enum_migration_records_disposition not null default 'blocked'::enum_migration_records_disposition,
        "created_by_migration" boolean default false,
        "destination_updated_at" timestamp(3) with time zone,
        "attempts" numeric default 0,
        "last_error" character varying,
        "metadata" jsonb,
        "raw_payload" jsonb,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_redirects" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "job_id" uuid,
        "source_id" uuid,
        "record_id" uuid,
        "from_url" character varying not null,
        "to_url" character varying not null,
        "resource" character varying,
        "source_record_id" character varying,
        "destination_collection" character varying,
        "destination_id" character varying,
        "status" enum_migration_redirects_status not null default 'proposed'::enum_migration_redirects_status,
        "redirect_id" uuid,
        "message" character varying,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."migration_sources" (
        "id" uuid not null default gen_random_uuid(),
        "site_id" uuid,
        "name" character varying not null,
        "base_url" character varying not null,
        "installation" character varying not null,
        "wp_username" character varying,
        "wp_application_password" character varying,
        "woo_consumer_key" character varying,
        "woo_consumer_secret" character varying,
        "credentials_summary" character varying,
        "status" enum_migration_sources_status not null default 'untested'::enum_migration_sources_status,
        "inventory" jsonb,
        "coverage" jsonb,
        "last_checked_at" timestamp(3) with time zone,
        "last_error" character varying,
        "updated_at" timestamp(3) with time zone not null default now(),
        "created_at" timestamp(3) with time zone not null default now()
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_coupons" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "coupon_id" uuid,
        "code" character varying not null,
        "discount" numeric default 0
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_fees" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "name" character varying not null,
        "total" numeric not null,
        "tax_total" numeric default 0
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_items" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "product_id" uuid not null,
        "product_title" character varying not null,
        "variation_key" character varying,
        "variation_label" character varying,
        "sku" character varying,
        "quantity" numeric not null,
        "unit_price" numeric not null,
        "subtotal" numeric not null,
        "tax_total" numeric default 0,
        "total" numeric not null,
        "source_line_id" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_payment_history" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "method_id" character varying,
        "method_title" character varying,
        "transaction_id" character varying,
        "status" character varying,
        "amount" numeric,
        "paid_at" timestamp(3) with time zone,
        "note" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_refunds" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "source_id" character varying,
        "amount" numeric not null,
        "reason" character varying,
        "refunded_at" timestamp(3) with time zone,
        "transaction_id" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_shipping_lines" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "method_id" character varying,
        "method_title" character varying not null,
        "total" numeric default 0,
        "tax_total" numeric default 0
    );
    CREATE TABLE IF NOT EXISTS "public"."orders_tax_lines" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "label" character varying not null,
        "rate_code" character varying,
        "rate_percent" numeric,
        "tax_total" numeric default 0,
        "shipping_tax_total" numeric default 0
    );
    CREATE TABLE IF NOT EXISTS "public"."products_attributes" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "key" character varying,
        "visible" boolean default true,
        "used_for_variation" boolean default false
    );
    CREATE TABLE IF NOT EXISTS "public"."products_attributes_locales" (
        "name" character varying,
        "id" integer not null default nextval('products_attributes_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" character varying not null
    );
    CREATE TABLE IF NOT EXISTS "public"."products_attributes_options" (
        "_order" integer not null,
        "_parent_id" character varying not null,
        "id" character varying not null
    );
    CREATE TABLE IF NOT EXISTS "public"."products_attributes_options_locales" (
        "value" character varying,
        "id" integer not null default nextval('products_attributes_options_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" character varying not null
    );
    CREATE TABLE IF NOT EXISTS "public"."products_rels" (
        "id" integer not null default nextval('products_rels_id_seq'::regclass),
        "order" integer,
        "parent_id" uuid not null,
        "path" character varying not null,
        "products_id" uuid,
        "media_id" uuid,
        "taxonomy_terms_id" uuid
    );
    CREATE TABLE IF NOT EXISTS "public"."products_variations" (
        "_order" integer not null,
        "_parent_id" uuid not null,
        "id" character varying not null,
        "key" character varying,
        "sku" character varying,
        "price" numeric,
        "compare_at_price" numeric,
        "track_inventory" boolean default false,
        "inventory" numeric,
        "image_id" uuid,
        "attribute_values" jsonb,
        "active" boolean default true,
        "weight" character varying,
        "source_id" character varying,
        "source_status" character varying
    );
    CREATE TABLE IF NOT EXISTS "public"."products_variations_locales" (
        "label" character varying,
        "id" integer not null default nextval('products_variations_locales_id_seq'::regclass),
        "_locale" _locales not null,
        "_parent_id" character varying not null
    );
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_parent_id" uuid;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_content_hash" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_installation" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_mapping_status" enum__pages_v_version_source_mapping_status default 'manual'::enum__pages_v_version_source_mapping_status;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_modified_at" timestamp(3) with time zone;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_permalink" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_raw_payload" jsonb;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_source_author_id" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_source_id" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_source_status" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_source_type" character varying;
    alter table "public"."_pages_v" ADD COLUMN IF NOT EXISTS "version_source_system" enum__pages_v_version_source_system default 'eshobe'::enum__pages_v_version_source_system;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_content_hash" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_installation" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_mapping_status" enum__posts_v_version_source_mapping_status default 'manual'::enum__posts_v_version_source_mapping_status;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_modified_at" timestamp(3) with time zone;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_permalink" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_raw_payload" jsonb;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_source_author_id" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_source_id" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_source_status" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_source_type" character varying;
    alter table "public"."_posts_v" ADD COLUMN IF NOT EXISTS "version_source_system" enum__posts_v_version_source_system default 'eshobe'::enum__posts_v_version_source_system;
    alter table "public"."_posts_v_rels" ADD COLUMN IF NOT EXISTS "taxonomy_terms_id" uuid;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_canonical_url" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_downloadable" boolean default false;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_external_url" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_height" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_length" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_noindex" boolean default false;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_product_type" enum__products_v_version_product_type default 'simple'::enum__products_v_version_product_type;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_content_hash" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_installation" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_mapping_status" enum__products_v_version_source_mapping_status default 'manual'::enum__products_v_version_source_mapping_status;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_modified_at" timestamp(3) with time zone;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_permalink" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_raw_payload" jsonb;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_source_author_id" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_source_id" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_source_status" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_source_type" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_source_system" enum__products_v_version_source_system default 'eshobe'::enum__products_v_version_source_system;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_virtual" boolean default false;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_weight" character varying;
    alter table "public"."_products_v" ADD COLUMN IF NOT EXISTS "version_width" character varying;
    alter table "public"."_products_v_locales" ADD COLUMN IF NOT EXISTS "version_body" jsonb;
    alter table "public"."_products_v_locales" ADD COLUMN IF NOT EXISTS "version_button_text" character varying;
    alter table "public"."_products_v_locales" ADD COLUMN IF NOT EXISTS "version_meta_description" character varying;
    alter table "public"."_products_v_locales" ADD COLUMN IF NOT EXISTS "version_meta_title" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_content_hash" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_installation" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_mapping_status" enum_categories_source_mapping_status default 'manual'::enum_categories_source_mapping_status;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_modified_at" timestamp(3) with time zone;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_permalink" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_raw_payload" jsonb;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_source_author_id" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_source_id" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_source_status" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_source_type" character varying;
    alter table "public"."categories" ADD COLUMN IF NOT EXISTS "source_system" enum_categories_source_system default 'eshobe'::enum_categories_source_system;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_content_hash" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_installation" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_mapping_status" enum_media_source_mapping_status default 'manual'::enum_media_source_mapping_status;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_modified_at" timestamp(3) with time zone;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_permalink" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_raw_payload" jsonb;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_source_author_id" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_source_id" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_source_status" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_source_type" character varying;
    alter table "public"."media" ADD COLUMN IF NOT EXISTS "source_system" enum_media_source_system default 'eshobe'::enum_media_source_system;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_address1" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_address2" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_city" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_company" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_country" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_email" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_first_name" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_last_name" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_phone" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_postcode" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "billing_address_state" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "customer_id" uuid;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "customer_note" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "discount_total" numeric default 0;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_address1" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_address2" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_city" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_company" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_country" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_email" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_first_name" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_last_name" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_phone" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_postcode" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_address_state" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "shipping_total" numeric default 0;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_content_hash" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_installation" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_mapping_status" enum_orders_source_mapping_status default 'manual'::enum_orders_source_mapping_status;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_modified_at" timestamp(3) with time zone;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_permalink" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_raw_payload" jsonb;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_source_author_id" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_source_id" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_source_status" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_source_type" character varying;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "source_system" enum_orders_source_system default 'eshobe'::enum_orders_source_system;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "subtotal" numeric;
    alter table "public"."orders" ADD COLUMN IF NOT EXISTS "tax_total" numeric default 0;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "parent_id" uuid;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_content_hash" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_installation" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_mapping_status" enum_pages_source_mapping_status default 'manual'::enum_pages_source_mapping_status;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_modified_at" timestamp(3) with time zone;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_permalink" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_raw_payload" jsonb;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_source_author_id" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_source_id" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_source_status" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_source_type" character varying;
    alter table "public"."pages" ADD COLUMN IF NOT EXISTS "source_system" enum_pages_source_system default 'eshobe'::enum_pages_source_system;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "coupons_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "customers_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_audits_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_batches_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_errors_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_events_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_jobs_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_mappings_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_records_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_redirects_id" uuid;
    alter table "public"."payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "migration_sources_id" uuid;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_content_hash" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_installation" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_mapping_status" enum_posts_source_mapping_status default 'manual'::enum_posts_source_mapping_status;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_modified_at" timestamp(3) with time zone;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_permalink" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_raw_payload" jsonb;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_source_author_id" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_source_id" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_source_status" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_source_type" character varying;
    alter table "public"."posts" ADD COLUMN IF NOT EXISTS "source_system" enum_posts_source_system default 'eshobe'::enum_posts_source_system;
    alter table "public"."posts_rels" ADD COLUMN IF NOT EXISTS "taxonomy_terms_id" uuid;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "canonical_url" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "downloadable" boolean default false;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "external_url" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "height" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "length" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "noindex" boolean default false;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "product_type" enum_products_product_type default 'simple'::enum_products_product_type;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_content_hash" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_installation" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_mapping_status" enum_products_source_mapping_status default 'manual'::enum_products_source_mapping_status;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_modified_at" timestamp(3) with time zone;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_permalink" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_raw_payload" jsonb;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_source_author_id" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_source_id" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_source_status" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_source_type" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "source_system" enum_products_source_system default 'eshobe'::enum_products_source_system;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "virtual" boolean default false;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "weight" character varying;
    alter table "public"."products" ADD COLUMN IF NOT EXISTS "width" character varying;
    alter table "public"."products_locales" ADD COLUMN IF NOT EXISTS "body" jsonb;
    alter table "public"."products_locales" ADD COLUMN IF NOT EXISTS "button_text" character varying;
    alter table "public"."products_locales" ADD COLUMN IF NOT EXISTS "meta_description" character varying;
    alter table "public"."products_locales" ADD COLUMN IF NOT EXISTS "meta_title" character varying;
    alter sequence "public"."_products_v_rels_id_seq" owned by "public"."_products_v_rels"."id";
    alter sequence "public"."_products_v_version_attributes_locales_id_seq" owned by "public"."_products_v_version_attributes_locales"."id";
    alter sequence "public"."_products_v_version_attributes_options_locales_id_seq" owned by "public"."_products_v_version_attributes_options_locales"."id";
    alter sequence "public"."_products_v_version_variations_locales_id_seq" owned by "public"."_products_v_version_variations_locales"."id";
    alter sequence "public"."coupons_locales_id_seq" owned by "public"."coupons_locales"."id";
    alter sequence "public"."coupons_rels_id_seq" owned by "public"."coupons_rels"."id";
    alter sequence "public"."products_attributes_locales_id_seq" owned by "public"."products_attributes_locales"."id";
    alter sequence "public"."products_attributes_options_locales_id_seq" owned by "public"."products_attributes_options_locales"."id";
    alter sequence "public"."products_rels_id_seq" owned by "public"."products_rels"."id";
    alter sequence "public"."products_variations_locales_id_seq" owned by "public"."products_variations_locales"."id";
    CREATE INDEX IF NOT EXISTS _pages_v_version_source_version_source_source_id_idx ON public._pages_v USING btree (version_source_source_id);
    CREATE INDEX IF NOT EXISTS _pages_v_version_source_version_source_system_idx ON public._pages_v USING btree (version_source_system);
    CREATE INDEX IF NOT EXISTS _pages_v_version_version_parent_idx ON public._pages_v USING btree (version_parent_id);
    CREATE INDEX IF NOT EXISTS _posts_v_rels_taxonomy_terms_id_idx ON public._posts_v_rels USING btree (taxonomy_terms_id);
    CREATE INDEX IF NOT EXISTS _posts_v_version_source_version_source_source_id_idx ON public._posts_v USING btree (version_source_source_id);
    CREATE INDEX IF NOT EXISTS _posts_v_version_source_version_source_system_idx ON public._posts_v USING btree (version_source_system);
    CREATE INDEX IF NOT EXISTS _products_v_rels_media_id_idx ON public._products_v_rels USING btree (media_id);
    CREATE INDEX IF NOT EXISTS _products_v_rels_order_idx ON public._products_v_rels USING btree ("order");
    CREATE INDEX IF NOT EXISTS _products_v_rels_parent_idx ON public._products_v_rels USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS _products_v_rels_path_idx ON public._products_v_rels USING btree (path);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_rels_pkey ON public._products_v_rels USING btree (id);
    CREATE INDEX IF NOT EXISTS _products_v_rels_products_id_idx ON public._products_v_rels USING btree (products_id);
    CREATE INDEX IF NOT EXISTS _products_v_rels_taxonomy_terms_id_idx ON public._products_v_rels USING btree (taxonomy_terms_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_attributes_locales_locale_parent_id_uniq ON public._products_v_version_attributes_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_attributes_locales_pkey ON public._products_v_version_attributes_locales USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_attributes_options_locales_locale_parent ON public._products_v_version_attributes_options_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_attributes_options_locales_pkey ON public._products_v_version_attributes_options_locales USING btree (id);
    CREATE INDEX IF NOT EXISTS _products_v_version_attributes_options_order_idx ON public._products_v_version_attributes_options USING btree (_order);
    CREATE INDEX IF NOT EXISTS _products_v_version_attributes_options_parent_id_idx ON public._products_v_version_attributes_options USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_attributes_options_pkey ON public._products_v_version_attributes_options USING btree (id);
    CREATE INDEX IF NOT EXISTS _products_v_version_attributes_order_idx ON public._products_v_version_attributes USING btree (_order);
    CREATE INDEX IF NOT EXISTS _products_v_version_attributes_parent_id_idx ON public._products_v_version_attributes USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_attributes_pkey ON public._products_v_version_attributes USING btree (id);
    CREATE INDEX IF NOT EXISTS _products_v_version_source_version_source_source_id_idx ON public._products_v USING btree (version_source_source_id);
    CREATE INDEX IF NOT EXISTS _products_v_version_source_version_source_system_idx ON public._products_v USING btree (version_source_system);
    CREATE INDEX IF NOT EXISTS _products_v_version_variations_image_idx ON public._products_v_version_variations USING btree (image_id);
    CREATE INDEX IF NOT EXISTS _products_v_version_variations_key_idx ON public._products_v_version_variations USING btree (key);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_variations_locales_locale_parent_id_uniq ON public._products_v_version_variations_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_variations_locales_pkey ON public._products_v_version_variations_locales USING btree (id);
    CREATE INDEX IF NOT EXISTS _products_v_version_variations_order_idx ON public._products_v_version_variations USING btree (_order);
    CREATE INDEX IF NOT EXISTS _products_v_version_variations_parent_id_idx ON public._products_v_version_variations USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS _products_v_version_variations_pkey ON public._products_v_version_variations USING btree (id);
    CREATE INDEX IF NOT EXISTS _products_v_version_variations_sku_idx ON public._products_v_version_variations USING btree (sku);
    CREATE INDEX IF NOT EXISTS _products_v_version_variations_source_id_idx ON public._products_v_version_variations USING btree (source_id);
    CREATE INDEX IF NOT EXISTS categories_source_source_source_id_idx ON public.categories USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS categories_source_source_system_idx ON public.categories USING btree (source_system);
    CREATE INDEX IF NOT EXISTS coupons_code_idx ON public.coupons USING btree (code);
    CREATE INDEX IF NOT EXISTS coupons_created_at_idx ON public.coupons USING btree (created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS coupons_locales_locale_parent_id_unique ON public.coupons_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS coupons_locales_pkey ON public.coupons_locales USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS coupons_pkey ON public.coupons USING btree (id);
    CREATE INDEX IF NOT EXISTS coupons_rels_order_idx ON public.coupons_rels USING btree ("order");
    CREATE INDEX IF NOT EXISTS coupons_rels_parent_idx ON public.coupons_rels USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS coupons_rels_path_idx ON public.coupons_rels USING btree (path);
    CREATE UNIQUE INDEX IF NOT EXISTS coupons_rels_pkey ON public.coupons_rels USING btree (id);
    CREATE INDEX IF NOT EXISTS coupons_rels_products_id_idx ON public.coupons_rels USING btree (products_id);
    CREATE INDEX IF NOT EXISTS coupons_site_idx ON public.coupons USING btree (site_id);
    CREATE INDEX IF NOT EXISTS coupons_source_source_source_id_idx ON public.coupons USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS coupons_source_source_system_idx ON public.coupons USING btree (source_system);
    CREATE INDEX IF NOT EXISTS coupons_updated_at_idx ON public.coupons USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS customers_addresses_order_idx ON public.customers_addresses USING btree (_order);
    CREATE INDEX IF NOT EXISTS customers_addresses_parent_id_idx ON public.customers_addresses USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS customers_addresses_pkey ON public.customers_addresses USING btree (id);
    CREATE INDEX IF NOT EXISTS customers_created_at_idx ON public.customers USING btree (created_at);
    CREATE INDEX IF NOT EXISTS customers_email_idx ON public.customers USING btree (email);
    CREATE INDEX IF NOT EXISTS customers_phone_idx ON public.customers USING btree (phone);
    CREATE UNIQUE INDEX IF NOT EXISTS customers_pkey ON public.customers USING btree (id);
    CREATE INDEX IF NOT EXISTS customers_site_idx ON public.customers USING btree (site_id);
    CREATE INDEX IF NOT EXISTS customers_source_source_source_id_idx ON public.customers USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS customers_source_source_system_idx ON public.customers USING btree (source_system);
    CREATE INDEX IF NOT EXISTS customers_updated_at_idx ON public.customers USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS media_source_source_source_id_idx ON public.media USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS media_source_source_system_idx ON public.media USING btree (source_system);
    CREATE INDEX IF NOT EXISTS migration_audits_action_idx ON public.migration_audits USING btree (action);
    CREATE INDEX IF NOT EXISTS migration_audits_actor_idx ON public.migration_audits USING btree (actor_id);
    CREATE INDEX IF NOT EXISTS migration_audits_created_at_idx ON public.migration_audits USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_audits_job_idx ON public.migration_audits USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_audits_pkey ON public.migration_audits USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_audits_site_idx ON public.migration_audits USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_audits_source_idx ON public.migration_audits USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_audits_updated_at_idx ON public.migration_audits USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_batches_created_at_idx ON public.migration_batches USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_batches_job_idx ON public.migration_batches USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_batches_pkey ON public.migration_batches USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_batches_resource_idx ON public.migration_batches USING btree (resource);
    CREATE INDEX IF NOT EXISTS migration_batches_run_id_idx ON public.migration_batches USING btree (run_id);
    CREATE INDEX IF NOT EXISTS migration_batches_site_idx ON public.migration_batches USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_batches_source_idx ON public.migration_batches USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_batches_updated_at_idx ON public.migration_batches USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_errors_batch_idx ON public.migration_errors USING btree (batch_id);
    CREATE INDEX IF NOT EXISTS migration_errors_code_idx ON public.migration_errors USING btree (code);
    CREATE INDEX IF NOT EXISTS migration_errors_created_at_idx ON public.migration_errors USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_errors_job_idx ON public.migration_errors USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_errors_pkey ON public.migration_errors USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_errors_record_idx ON public.migration_errors USING btree (record_id);
    CREATE INDEX IF NOT EXISTS migration_errors_resource_idx ON public.migration_errors USING btree (resource);
    CREATE INDEX IF NOT EXISTS migration_errors_site_idx ON public.migration_errors USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_errors_source_idx ON public.migration_errors USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_errors_source_record_id_idx ON public.migration_errors USING btree (source_record_id);
    CREATE INDEX IF NOT EXISTS migration_errors_updated_at_idx ON public.migration_errors USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_events_created_at_idx ON public.migration_events USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_events_event_type_idx ON public.migration_events USING btree (event_type);
    CREATE INDEX IF NOT EXISTS migration_events_job_idx ON public.migration_events USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_events_pkey ON public.migration_events USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_events_resource_idx ON public.migration_events USING btree (resource);
    CREATE INDEX IF NOT EXISTS migration_events_site_idx ON public.migration_events USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_events_source_idx ON public.migration_events USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_events_source_record_id_idx ON public.migration_events USING btree (source_record_id);
    CREATE INDEX IF NOT EXISTS migration_events_updated_at_idx ON public.migration_events USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_jobs_created_at_idx ON public.migration_jobs USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_jobs_current_run_id_idx ON public.migration_jobs USING btree (current_run_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_jobs_pkey ON public.migration_jobs USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_jobs_run_requested_at_idx ON public.migration_jobs USING btree (run_requested_at);
    CREATE INDEX IF NOT EXISTS migration_jobs_site_idx ON public.migration_jobs USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_jobs_source_idx ON public.migration_jobs USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_jobs_updated_at_idx ON public.migration_jobs USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_mappings_created_at_idx ON public.migration_mappings USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_mappings_job_idx ON public.migration_mappings USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_mappings_pkey ON public.migration_mappings USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_mappings_resource_idx ON public.migration_mappings USING btree (resource);
    CREATE INDEX IF NOT EXISTS migration_mappings_site_idx ON public.migration_mappings USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_mappings_source_field_idx ON public.migration_mappings USING btree (source_field);
    CREATE INDEX IF NOT EXISTS migration_mappings_source_idx ON public.migration_mappings USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_mappings_updated_at_idx ON public.migration_mappings USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_records_content_hash_idx ON public.migration_records USING btree (content_hash);
    CREATE INDEX IF NOT EXISTS migration_records_created_at_idx ON public.migration_records USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_records_destination_collection_idx ON public.migration_records USING btree (destination_collection);
    CREATE INDEX IF NOT EXISTS migration_records_destination_id_idx ON public.migration_records USING btree (destination_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_records_idempotency_key_idx ON public.migration_records USING btree (idempotency_key);
    CREATE INDEX IF NOT EXISTS migration_records_installation_idx ON public.migration_records USING btree (installation);
    CREATE INDEX IF NOT EXISTS migration_records_job_idx ON public.migration_records USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_records_pkey ON public.migration_records USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_records_resource_idx ON public.migration_records USING btree (resource);
    CREATE INDEX IF NOT EXISTS migration_records_site_idx ON public.migration_records USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_records_source_idx ON public.migration_records USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_records_source_modified_at_idx ON public.migration_records USING btree (source_modified_at);
    CREATE INDEX IF NOT EXISTS migration_records_source_record_id_idx ON public.migration_records USING btree (source_record_id);
    CREATE INDEX IF NOT EXISTS migration_records_updated_at_idx ON public.migration_records USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_redirects_created_at_idx ON public.migration_redirects USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_redirects_from_url_idx ON public.migration_redirects USING btree (from_url);
    CREATE INDEX IF NOT EXISTS migration_redirects_job_idx ON public.migration_redirects USING btree (job_id);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_redirects_pkey ON public.migration_redirects USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_redirects_record_idx ON public.migration_redirects USING btree (record_id);
    CREATE INDEX IF NOT EXISTS migration_redirects_redirect_idx ON public.migration_redirects USING btree (redirect_id);
    CREATE INDEX IF NOT EXISTS migration_redirects_resource_idx ON public.migration_redirects USING btree (resource);
    CREATE INDEX IF NOT EXISTS migration_redirects_site_idx ON public.migration_redirects USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_redirects_source_idx ON public.migration_redirects USING btree (source_id);
    CREATE INDEX IF NOT EXISTS migration_redirects_source_record_id_idx ON public.migration_redirects USING btree (source_record_id);
    CREATE INDEX IF NOT EXISTS migration_redirects_updated_at_idx ON public.migration_redirects USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS migration_sources_base_url_idx ON public.migration_sources USING btree (base_url);
    CREATE INDEX IF NOT EXISTS migration_sources_created_at_idx ON public.migration_sources USING btree (created_at);
    CREATE INDEX IF NOT EXISTS migration_sources_installation_idx ON public.migration_sources USING btree (installation);
    CREATE UNIQUE INDEX IF NOT EXISTS migration_sources_pkey ON public.migration_sources USING btree (id);
    CREATE INDEX IF NOT EXISTS migration_sources_site_idx ON public.migration_sources USING btree (site_id);
    CREATE INDEX IF NOT EXISTS migration_sources_updated_at_idx ON public.migration_sources USING btree (updated_at);
    CREATE INDEX IF NOT EXISTS orders_coupons_coupon_idx ON public.orders_coupons USING btree (coupon_id);
    CREATE INDEX IF NOT EXISTS orders_coupons_order_idx ON public.orders_coupons USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_coupons_parent_id_idx ON public.orders_coupons USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_coupons_pkey ON public.orders_coupons USING btree (id);
    CREATE INDEX IF NOT EXISTS orders_customer_idx ON public.orders USING btree (customer_id);
    CREATE INDEX IF NOT EXISTS orders_fees_order_idx ON public.orders_fees USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_fees_parent_id_idx ON public.orders_fees USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_fees_pkey ON public.orders_fees USING btree (id);
    CREATE INDEX IF NOT EXISTS orders_items_order_idx ON public.orders_items USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_items_parent_id_idx ON public.orders_items USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_items_pkey ON public.orders_items USING btree (id);
    CREATE INDEX IF NOT EXISTS orders_items_product_idx ON public.orders_items USING btree (product_id);
    CREATE INDEX IF NOT EXISTS orders_items_source_line_id_idx ON public.orders_items USING btree (source_line_id);
    CREATE INDEX IF NOT EXISTS orders_items_variation_key_idx ON public.orders_items USING btree (variation_key);
    CREATE INDEX IF NOT EXISTS orders_payment_history_order_idx ON public.orders_payment_history USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_payment_history_parent_id_idx ON public.orders_payment_history USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_history_pkey ON public.orders_payment_history USING btree (id);
    CREATE INDEX IF NOT EXISTS orders_refunds_order_idx ON public.orders_refunds USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_refunds_parent_id_idx ON public.orders_refunds USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_refunds_pkey ON public.orders_refunds USING btree (id);
    CREATE INDEX IF NOT EXISTS orders_refunds_source_id_idx ON public.orders_refunds USING btree (source_id);
    CREATE INDEX IF NOT EXISTS orders_shipping_lines_order_idx ON public.orders_shipping_lines USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_shipping_lines_parent_id_idx ON public.orders_shipping_lines USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_shipping_lines_pkey ON public.orders_shipping_lines USING btree (id);
    CREATE INDEX IF NOT EXISTS orders_source_source_source_id_idx ON public.orders USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS orders_source_source_system_idx ON public.orders USING btree (source_system);
    CREATE INDEX IF NOT EXISTS orders_tax_lines_order_idx ON public.orders_tax_lines USING btree (_order);
    CREATE INDEX IF NOT EXISTS orders_tax_lines_parent_id_idx ON public.orders_tax_lines USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS orders_tax_lines_pkey ON public.orders_tax_lines USING btree (id);
    CREATE INDEX IF NOT EXISTS pages_parent_idx ON public.pages USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS pages_source_source_source_id_idx ON public.pages USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS pages_source_source_system_idx ON public.pages USING btree (source_system);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_coupons_id_idx ON public.payload_locked_documents_rels USING btree (coupons_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_customers_id_idx ON public.payload_locked_documents_rels USING btree (customers_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_audits_id_idx ON public.payload_locked_documents_rels USING btree (migration_audits_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_batches_id_idx ON public.payload_locked_documents_rels USING btree (migration_batches_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_errors_id_idx ON public.payload_locked_documents_rels USING btree (migration_errors_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_events_id_idx ON public.payload_locked_documents_rels USING btree (migration_events_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_jobs_id_idx ON public.payload_locked_documents_rels USING btree (migration_jobs_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_mappings_id_idx ON public.payload_locked_documents_rels USING btree (migration_mappings_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_records_id_idx ON public.payload_locked_documents_rels USING btree (migration_records_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_redirects_id_idx ON public.payload_locked_documents_rels USING btree (migration_redirects_id);
    CREATE INDEX IF NOT EXISTS payload_locked_documents_rels_migration_sources_id_idx ON public.payload_locked_documents_rels USING btree (migration_sources_id);
    CREATE INDEX IF NOT EXISTS posts_rels_taxonomy_terms_id_idx ON public.posts_rels USING btree (taxonomy_terms_id);
    CREATE INDEX IF NOT EXISTS posts_source_source_source_id_idx ON public.posts USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS posts_source_source_system_idx ON public.posts USING btree (source_system);
    CREATE UNIQUE INDEX IF NOT EXISTS products_attributes_locales_locale_parent_id_unique ON public.products_attributes_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_attributes_locales_pkey ON public.products_attributes_locales USING btree (id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_attributes_options_locales_locale_parent_id_unique ON public.products_attributes_options_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_attributes_options_locales_pkey ON public.products_attributes_options_locales USING btree (id);
    CREATE INDEX IF NOT EXISTS products_attributes_options_order_idx ON public.products_attributes_options USING btree (_order);
    CREATE INDEX IF NOT EXISTS products_attributes_options_parent_id_idx ON public.products_attributes_options USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_attributes_options_pkey ON public.products_attributes_options USING btree (id);
    CREATE INDEX IF NOT EXISTS products_attributes_order_idx ON public.products_attributes USING btree (_order);
    CREATE INDEX IF NOT EXISTS products_attributes_parent_id_idx ON public.products_attributes USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_attributes_pkey ON public.products_attributes USING btree (id);
    CREATE INDEX IF NOT EXISTS products_rels_media_id_idx ON public.products_rels USING btree (media_id);
    CREATE INDEX IF NOT EXISTS products_rels_order_idx ON public.products_rels USING btree ("order");
    CREATE INDEX IF NOT EXISTS products_rels_parent_idx ON public.products_rels USING btree (parent_id);
    CREATE INDEX IF NOT EXISTS products_rels_path_idx ON public.products_rels USING btree (path);
    CREATE UNIQUE INDEX IF NOT EXISTS products_rels_pkey ON public.products_rels USING btree (id);
    CREATE INDEX IF NOT EXISTS products_rels_products_id_idx ON public.products_rels USING btree (products_id);
    CREATE INDEX IF NOT EXISTS products_rels_taxonomy_terms_id_idx ON public.products_rels USING btree (taxonomy_terms_id);
    CREATE INDEX IF NOT EXISTS products_source_source_source_id_idx ON public.products USING btree (source_source_id);
    CREATE INDEX IF NOT EXISTS products_source_source_system_idx ON public.products USING btree (source_system);
    CREATE INDEX IF NOT EXISTS products_variations_image_idx ON public.products_variations USING btree (image_id);
    CREATE INDEX IF NOT EXISTS products_variations_key_idx ON public.products_variations USING btree (key);
    CREATE UNIQUE INDEX IF NOT EXISTS products_variations_locales_locale_parent_id_unique ON public.products_variations_locales USING btree (_locale, _parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_variations_locales_pkey ON public.products_variations_locales USING btree (id);
    CREATE INDEX IF NOT EXISTS products_variations_order_idx ON public.products_variations USING btree (_order);
    CREATE INDEX IF NOT EXISTS products_variations_parent_id_idx ON public.products_variations USING btree (_parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS products_variations_pkey ON public.products_variations USING btree (id);
    CREATE INDEX IF NOT EXISTS products_variations_sku_idx ON public.products_variations USING btree (sku);
    CREATE INDEX IF NOT EXISTS products_variations_source_id_idx ON public.products_variations USING btree (source_id);
    CREATE INDEX IF NOT EXISTS redirects_from_idx ON public.redirects USING btree ("from");
    DO $$ BEGIN
          alter table "public"."_products_v_rels" add constraint "_products_v_rels_pkey" PRIMARY KEY using index "_products_v_rels_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes" add constraint "_products_v_version_attributes_pkey" PRIMARY KEY using index "_products_v_version_attributes_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes_locales" add constraint "_products_v_version_attributes_locales_pkey" PRIMARY KEY using index "_products_v_version_attributes_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes_options" add constraint "_products_v_version_attributes_options_pkey" PRIMARY KEY using index "_products_v_version_attributes_options_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes_options_locales" add constraint "_products_v_version_attributes_options_locales_pkey" PRIMARY KEY using index "_products_v_version_attributes_options_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_products_v_version_variations" add constraint "_products_v_version_variations_pkey" PRIMARY KEY using index "_products_v_version_variations_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_products_v_version_variations_locales" add constraint "_products_v_version_variations_locales_pkey" PRIMARY KEY using index "_products_v_version_variations_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."coupons" add constraint "coupons_pkey" PRIMARY KEY using index "coupons_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."coupons_locales" add constraint "coupons_locales_pkey" PRIMARY KEY using index "coupons_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."coupons_rels" add constraint "coupons_rels_pkey" PRIMARY KEY using index "coupons_rels_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."customers" add constraint "customers_pkey" PRIMARY KEY using index "customers_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."customers_addresses" add constraint "customers_addresses_pkey" PRIMARY KEY using index "customers_addresses_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_audits" add constraint "migration_audits_pkey" PRIMARY KEY using index "migration_audits_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_batches" add constraint "migration_batches_pkey" PRIMARY KEY using index "migration_batches_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_errors" add constraint "migration_errors_pkey" PRIMARY KEY using index "migration_errors_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_events" add constraint "migration_events_pkey" PRIMARY KEY using index "migration_events_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_jobs" add constraint "migration_jobs_pkey" PRIMARY KEY using index "migration_jobs_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_mappings" add constraint "migration_mappings_pkey" PRIMARY KEY using index "migration_mappings_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_records" add constraint "migration_records_pkey" PRIMARY KEY using index "migration_records_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_redirects" add constraint "migration_redirects_pkey" PRIMARY KEY using index "migration_redirects_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."migration_sources" add constraint "migration_sources_pkey" PRIMARY KEY using index "migration_sources_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_coupons" add constraint "orders_coupons_pkey" PRIMARY KEY using index "orders_coupons_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_fees" add constraint "orders_fees_pkey" PRIMARY KEY using index "orders_fees_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_items" add constraint "orders_items_pkey" PRIMARY KEY using index "orders_items_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_payment_history" add constraint "orders_payment_history_pkey" PRIMARY KEY using index "orders_payment_history_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_refunds" add constraint "orders_refunds_pkey" PRIMARY KEY using index "orders_refunds_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_shipping_lines" add constraint "orders_shipping_lines_pkey" PRIMARY KEY using index "orders_shipping_lines_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."orders_tax_lines" add constraint "orders_tax_lines_pkey" PRIMARY KEY using index "orders_tax_lines_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_attributes" add constraint "products_attributes_pkey" PRIMARY KEY using index "products_attributes_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_attributes_locales" add constraint "products_attributes_locales_pkey" PRIMARY KEY using index "products_attributes_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_attributes_options" add constraint "products_attributes_options_pkey" PRIMARY KEY using index "products_attributes_options_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_attributes_options_locales" add constraint "products_attributes_options_locales_pkey" PRIMARY KEY using index "products_attributes_options_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_rels" add constraint "products_rels_pkey" PRIMARY KEY using index "products_rels_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_variations" add constraint "products_variations_pkey" PRIMARY KEY using index "products_variations_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."products_variations_locales" add constraint "products_variations_locales_pkey" PRIMARY KEY using index "products_variations_locales_pkey";
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    DO $$ BEGIN
          alter table "public"."_pages_v" add constraint "_pages_v_version_parent_id_pages_id_fk" FOREIGN KEY (version_parent_id) REFERENCES pages(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_pages_v" validate constraint "_pages_v_version_parent_id_pages_id_fk";
    DO $$ BEGIN
          alter table "public"."_posts_v_rels" add constraint "_posts_v_rels_taxonomy_terms_fk" FOREIGN KEY (taxonomy_terms_id) REFERENCES taxonomy_terms(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_posts_v_rels" validate constraint "_posts_v_rels_taxonomy_terms_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_rels" add constraint "_products_v_rels_media_fk" FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_rels" validate constraint "_products_v_rels_media_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_rels" add constraint "_products_v_rels_parent_fk" FOREIGN KEY (parent_id) REFERENCES _products_v(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_rels" validate constraint "_products_v_rels_parent_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_rels" add constraint "_products_v_rels_products_fk" FOREIGN KEY (products_id) REFERENCES products(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_rels" validate constraint "_products_v_rels_products_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_rels" add constraint "_products_v_rels_taxonomy_terms_fk" FOREIGN KEY (taxonomy_terms_id) REFERENCES taxonomy_terms(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_rels" validate constraint "_products_v_rels_taxonomy_terms_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes" add constraint "_products_v_version_attributes_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES _products_v(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_attributes" validate constraint "_products_v_version_attributes_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes_locales" add constraint "_products_v_version_attributes_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES _products_v_version_attributes(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_attributes_locales" validate constraint "_products_v_version_attributes_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes_options" add constraint "_products_v_version_attributes_options_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES _products_v_version_attributes(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_attributes_options" validate constraint "_products_v_version_attributes_options_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_attributes_options_locales" add constraint "_products_v_version_attributes_options_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES _products_v_version_attributes_options(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_attributes_options_locales" validate constraint "_products_v_version_attributes_options_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_variations" add constraint "_products_v_version_variations_image_id_media_id_fk" FOREIGN KEY (image_id) REFERENCES media(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_variations" validate constraint "_products_v_version_variations_image_id_media_id_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_variations" add constraint "_products_v_version_variations_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES _products_v(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_variations" validate constraint "_products_v_version_variations_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."_products_v_version_variations_locales" add constraint "_products_v_version_variations_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES _products_v_version_variations(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."_products_v_version_variations_locales" validate constraint "_products_v_version_variations_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."coupons" add constraint "coupons_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."coupons" validate constraint "coupons_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."coupons_locales" add constraint "coupons_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES coupons(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."coupons_locales" validate constraint "coupons_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."coupons_rels" add constraint "coupons_rels_parent_fk" FOREIGN KEY (parent_id) REFERENCES coupons(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."coupons_rels" validate constraint "coupons_rels_parent_fk";
    DO $$ BEGIN
          alter table "public"."coupons_rels" add constraint "coupons_rels_products_fk" FOREIGN KEY (products_id) REFERENCES products(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."coupons_rels" validate constraint "coupons_rels_products_fk";
    DO $$ BEGIN
          alter table "public"."customers" add constraint "customers_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."customers" validate constraint "customers_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."customers_addresses" add constraint "customers_addresses_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES customers(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."customers_addresses" validate constraint "customers_addresses_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_audits" add constraint "migration_audits_actor_id_users_id_fk" FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_audits" validate constraint "migration_audits_actor_id_users_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_audits" add constraint "migration_audits_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_audits" validate constraint "migration_audits_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_audits" add constraint "migration_audits_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_audits" validate constraint "migration_audits_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_audits" add constraint "migration_audits_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_audits" validate constraint "migration_audits_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_batches" add constraint "migration_batches_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_batches" validate constraint "migration_batches_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_batches" add constraint "migration_batches_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_batches" validate constraint "migration_batches_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_batches" add constraint "migration_batches_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_batches" validate constraint "migration_batches_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_errors" add constraint "migration_errors_batch_id_migration_batches_id_fk" FOREIGN KEY (batch_id) REFERENCES migration_batches(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_errors" validate constraint "migration_errors_batch_id_migration_batches_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_errors" add constraint "migration_errors_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_errors" validate constraint "migration_errors_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_errors" add constraint "migration_errors_record_id_migration_records_id_fk" FOREIGN KEY (record_id) REFERENCES migration_records(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_errors" validate constraint "migration_errors_record_id_migration_records_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_errors" add constraint "migration_errors_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_errors" validate constraint "migration_errors_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_errors" add constraint "migration_errors_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_errors" validate constraint "migration_errors_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_events" add constraint "migration_events_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_events" validate constraint "migration_events_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_events" add constraint "migration_events_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_events" validate constraint "migration_events_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_events" add constraint "migration_events_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_events" validate constraint "migration_events_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_jobs" add constraint "migration_jobs_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_jobs" validate constraint "migration_jobs_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_jobs" add constraint "migration_jobs_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_jobs" validate constraint "migration_jobs_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_mappings" add constraint "migration_mappings_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_mappings" validate constraint "migration_mappings_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_mappings" add constraint "migration_mappings_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_mappings" validate constraint "migration_mappings_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_mappings" add constraint "migration_mappings_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_mappings" validate constraint "migration_mappings_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_records" add constraint "migration_records_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_records" validate constraint "migration_records_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_records" add constraint "migration_records_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_records" validate constraint "migration_records_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_records" add constraint "migration_records_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_records" validate constraint "migration_records_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_redirects" add constraint "migration_redirects_job_id_migration_jobs_id_fk" FOREIGN KEY (job_id) REFERENCES migration_jobs(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_redirects" validate constraint "migration_redirects_job_id_migration_jobs_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_redirects" add constraint "migration_redirects_record_id_migration_records_id_fk" FOREIGN KEY (record_id) REFERENCES migration_records(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_redirects" validate constraint "migration_redirects_record_id_migration_records_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_redirects" add constraint "migration_redirects_redirect_id_redirects_id_fk" FOREIGN KEY (redirect_id) REFERENCES redirects(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_redirects" validate constraint "migration_redirects_redirect_id_redirects_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_redirects" add constraint "migration_redirects_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_redirects" validate constraint "migration_redirects_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_redirects" add constraint "migration_redirects_source_id_migration_sources_id_fk" FOREIGN KEY (source_id) REFERENCES migration_sources(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_redirects" validate constraint "migration_redirects_source_id_migration_sources_id_fk";
    DO $$ BEGIN
          alter table "public"."migration_sources" add constraint "migration_sources_site_id_sites_id_fk" FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."migration_sources" validate constraint "migration_sources_site_id_sites_id_fk";
    DO $$ BEGIN
          alter table "public"."orders" add constraint "orders_customer_id_customers_id_fk" FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders" validate constraint "orders_customer_id_customers_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_coupons" add constraint "orders_coupons_coupon_id_coupons_id_fk" FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_coupons" validate constraint "orders_coupons_coupon_id_coupons_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_coupons" add constraint "orders_coupons_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_coupons" validate constraint "orders_coupons_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_fees" add constraint "orders_fees_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_fees" validate constraint "orders_fees_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_items" add constraint "orders_items_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_items" validate constraint "orders_items_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_items" add constraint "orders_items_product_id_products_id_fk" FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_items" validate constraint "orders_items_product_id_products_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_payment_history" add constraint "orders_payment_history_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_payment_history" validate constraint "orders_payment_history_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_refunds" add constraint "orders_refunds_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_refunds" validate constraint "orders_refunds_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_shipping_lines" add constraint "orders_shipping_lines_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_shipping_lines" validate constraint "orders_shipping_lines_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."orders_tax_lines" add constraint "orders_tax_lines_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES orders(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."orders_tax_lines" validate constraint "orders_tax_lines_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."pages" add constraint "pages_parent_id_pages_id_fk" FOREIGN KEY (parent_id) REFERENCES pages(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."pages" validate constraint "pages_parent_id_pages_id_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_coupons_fk" FOREIGN KEY (coupons_id) REFERENCES coupons(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_coupons_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_customers_fk" FOREIGN KEY (customers_id) REFERENCES customers(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_customers_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_audits_fk" FOREIGN KEY (migration_audits_id) REFERENCES migration_audits(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_audits_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_batches_fk" FOREIGN KEY (migration_batches_id) REFERENCES migration_batches(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_batches_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_errors_fk" FOREIGN KEY (migration_errors_id) REFERENCES migration_errors(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_errors_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_events_fk" FOREIGN KEY (migration_events_id) REFERENCES migration_events(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_events_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_jobs_fk" FOREIGN KEY (migration_jobs_id) REFERENCES migration_jobs(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_jobs_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_mappings_fk" FOREIGN KEY (migration_mappings_id) REFERENCES migration_mappings(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_mappings_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_records_fk" FOREIGN KEY (migration_records_id) REFERENCES migration_records(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_records_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_redirects_fk" FOREIGN KEY (migration_redirects_id) REFERENCES migration_redirects(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_redirects_fk";
    DO $$ BEGIN
          alter table "public"."payload_locked_documents_rels" add constraint "payload_locked_documents_rels_migration_sources_fk" FOREIGN KEY (migration_sources_id) REFERENCES migration_sources(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."payload_locked_documents_rels" validate constraint "payload_locked_documents_rels_migration_sources_fk";
    DO $$ BEGIN
          alter table "public"."posts_rels" add constraint "posts_rels_taxonomy_terms_fk" FOREIGN KEY (taxonomy_terms_id) REFERENCES taxonomy_terms(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."posts_rels" validate constraint "posts_rels_taxonomy_terms_fk";
    DO $$ BEGIN
          alter table "public"."products_attributes" add constraint "products_attributes_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES products(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_attributes" validate constraint "products_attributes_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."products_attributes_locales" add constraint "products_attributes_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES products_attributes(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_attributes_locales" validate constraint "products_attributes_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."products_attributes_options" add constraint "products_attributes_options_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES products_attributes(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_attributes_options" validate constraint "products_attributes_options_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."products_attributes_options_locales" add constraint "products_attributes_options_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES products_attributes_options(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_attributes_options_locales" validate constraint "products_attributes_options_locales_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."products_rels" add constraint "products_rels_media_fk" FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_rels" validate constraint "products_rels_media_fk";
    DO $$ BEGIN
          alter table "public"."products_rels" add constraint "products_rels_parent_fk" FOREIGN KEY (parent_id) REFERENCES products(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_rels" validate constraint "products_rels_parent_fk";
    DO $$ BEGIN
          alter table "public"."products_rels" add constraint "products_rels_products_fk" FOREIGN KEY (products_id) REFERENCES products(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_rels" validate constraint "products_rels_products_fk";
    DO $$ BEGIN
          alter table "public"."products_rels" add constraint "products_rels_taxonomy_terms_fk" FOREIGN KEY (taxonomy_terms_id) REFERENCES taxonomy_terms(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_rels" validate constraint "products_rels_taxonomy_terms_fk";
    DO $$ BEGIN
          alter table "public"."products_variations" add constraint "products_variations_image_id_media_id_fk" FOREIGN KEY (image_id) REFERENCES media(id) ON DELETE SET NULL not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_variations" validate constraint "products_variations_image_id_media_id_fk";
    DO $$ BEGIN
          alter table "public"."products_variations" add constraint "products_variations_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES products(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_variations" validate constraint "products_variations_parent_id_fk";
    DO $$ BEGIN
          alter table "public"."products_variations_locales" add constraint "products_variations_locales_parent_id_fk" FOREIGN KEY (_parent_id) REFERENCES products_variations(id) ON DELETE CASCADE not valid;
        EXCEPTION WHEN duplicate_object OR invalid_table_definition THEN NULL; END $$;
    alter table "public"."products_variations_locales" validate constraint "products_variations_locales_parent_id_fk";
    DROP INDEX IF EXISTS "public"."redirects_from_idx";
    CREATE INDEX IF NOT EXISTS "redirects_from_idx" ON "public"."redirects" USING btree ("from");
    CREATE UNIQUE INDEX IF NOT EXISTS "redirects_site_from_uidx" ON "public"."redirects" USING btree ("site_id", "from");
    UPDATE "orders" SET "subtotal" = "quantity" * "unit_price" WHERE "subtotal" IS NULL AND "total" = "quantity" * "unit_price";
    INSERT INTO "orders_items" (
              "_order", "_parent_id", "id", "product_id", "product_title",
              "variation_key", "variation_label", "sku", "quantity", "unit_price",
              "subtotal", "tax_total", "total", "source_line_id"
            )
            SELECT
              1, "id", substr(md5("id"::text || ':legacy-order-line'), 1, 24),
              "product_id", "product_title", NULL, NULL, NULL, "quantity",
              "unit_price", "quantity" * "unit_price", 0, "total", NULL
            FROM "orders"
            WHERE "total" = "quantity" * "unit_price"
              AND NULLIF("product_title", '') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM "orders_items" WHERE "_parent_id" = "orders"."id"
              )
            ON CONFLICT ("id") DO NOTHING;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "public"."redirects_site_from_uidx";
    DROP INDEX IF EXISTS "public"."redirects_from_idx";
    DROP TABLE IF EXISTS "public"."_products_v_rels" CASCADE;
    DROP TABLE IF EXISTS "public"."_products_v_version_attributes" CASCADE;
    DROP TABLE IF EXISTS "public"."_products_v_version_attributes_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."_products_v_version_attributes_options" CASCADE;
    DROP TABLE IF EXISTS "public"."_products_v_version_attributes_options_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."_products_v_version_variations" CASCADE;
    DROP TABLE IF EXISTS "public"."_products_v_version_variations_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."coupons" CASCADE;
    DROP TABLE IF EXISTS "public"."coupons_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."coupons_rels" CASCADE;
    DROP TABLE IF EXISTS "public"."customers" CASCADE;
    DROP TABLE IF EXISTS "public"."customers_addresses" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_audits" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_batches" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_errors" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_events" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_jobs" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_mappings" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_records" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_redirects" CASCADE;
    DROP TABLE IF EXISTS "public"."migration_sources" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_coupons" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_fees" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_items" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_payment_history" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_refunds" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_shipping_lines" CASCADE;
    DROP TABLE IF EXISTS "public"."orders_tax_lines" CASCADE;
    DROP TABLE IF EXISTS "public"."products_attributes" CASCADE;
    DROP TABLE IF EXISTS "public"."products_attributes_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."products_attributes_options" CASCADE;
    DROP TABLE IF EXISTS "public"."products_attributes_options_locales" CASCADE;
    DROP TABLE IF EXISTS "public"."products_rels" CASCADE;
    DROP TABLE IF EXISTS "public"."products_variations" CASCADE;
    DROP TABLE IF EXISTS "public"."products_variations_locales" CASCADE;
    ALTER TABLE "public"."_pages_v"
          DROP COLUMN IF EXISTS "version_parent_id",
          DROP COLUMN IF EXISTS "version_source_content_hash",
          DROP COLUMN IF EXISTS "version_source_installation",
          DROP COLUMN IF EXISTS "version_source_mapping_status",
          DROP COLUMN IF EXISTS "version_source_modified_at",
          DROP COLUMN IF EXISTS "version_source_permalink",
          DROP COLUMN IF EXISTS "version_source_raw_payload",
          DROP COLUMN IF EXISTS "version_source_source_author_id",
          DROP COLUMN IF EXISTS "version_source_source_id",
          DROP COLUMN IF EXISTS "version_source_source_status",
          DROP COLUMN IF EXISTS "version_source_source_type",
          DROP COLUMN IF EXISTS "version_source_system";
    ALTER TABLE "public"."_posts_v"
          DROP COLUMN IF EXISTS "version_source_content_hash",
          DROP COLUMN IF EXISTS "version_source_installation",
          DROP COLUMN IF EXISTS "version_source_mapping_status",
          DROP COLUMN IF EXISTS "version_source_modified_at",
          DROP COLUMN IF EXISTS "version_source_permalink",
          DROP COLUMN IF EXISTS "version_source_raw_payload",
          DROP COLUMN IF EXISTS "version_source_source_author_id",
          DROP COLUMN IF EXISTS "version_source_source_id",
          DROP COLUMN IF EXISTS "version_source_source_status",
          DROP COLUMN IF EXISTS "version_source_source_type",
          DROP COLUMN IF EXISTS "version_source_system";
    ALTER TABLE "public"."_posts_v_rels"
          DROP COLUMN IF EXISTS "taxonomy_terms_id";
    ALTER TABLE "public"."_products_v"
          DROP COLUMN IF EXISTS "version_canonical_url",
          DROP COLUMN IF EXISTS "version_downloadable",
          DROP COLUMN IF EXISTS "version_external_url",
          DROP COLUMN IF EXISTS "version_height",
          DROP COLUMN IF EXISTS "version_length",
          DROP COLUMN IF EXISTS "version_noindex",
          DROP COLUMN IF EXISTS "version_product_type",
          DROP COLUMN IF EXISTS "version_source_content_hash",
          DROP COLUMN IF EXISTS "version_source_installation",
          DROP COLUMN IF EXISTS "version_source_mapping_status",
          DROP COLUMN IF EXISTS "version_source_modified_at",
          DROP COLUMN IF EXISTS "version_source_permalink",
          DROP COLUMN IF EXISTS "version_source_raw_payload",
          DROP COLUMN IF EXISTS "version_source_source_author_id",
          DROP COLUMN IF EXISTS "version_source_source_id",
          DROP COLUMN IF EXISTS "version_source_source_status",
          DROP COLUMN IF EXISTS "version_source_source_type",
          DROP COLUMN IF EXISTS "version_source_system",
          DROP COLUMN IF EXISTS "version_virtual",
          DROP COLUMN IF EXISTS "version_weight",
          DROP COLUMN IF EXISTS "version_width";
    ALTER TABLE "public"."_products_v_locales"
          DROP COLUMN IF EXISTS "version_body",
          DROP COLUMN IF EXISTS "version_button_text",
          DROP COLUMN IF EXISTS "version_meta_description",
          DROP COLUMN IF EXISTS "version_meta_title";
    ALTER TABLE "public"."categories"
          DROP COLUMN IF EXISTS "source_content_hash",
          DROP COLUMN IF EXISTS "source_installation",
          DROP COLUMN IF EXISTS "source_mapping_status",
          DROP COLUMN IF EXISTS "source_modified_at",
          DROP COLUMN IF EXISTS "source_permalink",
          DROP COLUMN IF EXISTS "source_raw_payload",
          DROP COLUMN IF EXISTS "source_source_author_id",
          DROP COLUMN IF EXISTS "source_source_id",
          DROP COLUMN IF EXISTS "source_source_status",
          DROP COLUMN IF EXISTS "source_source_type",
          DROP COLUMN IF EXISTS "source_system";
    ALTER TABLE "public"."media"
          DROP COLUMN IF EXISTS "source_content_hash",
          DROP COLUMN IF EXISTS "source_installation",
          DROP COLUMN IF EXISTS "source_mapping_status",
          DROP COLUMN IF EXISTS "source_modified_at",
          DROP COLUMN IF EXISTS "source_permalink",
          DROP COLUMN IF EXISTS "source_raw_payload",
          DROP COLUMN IF EXISTS "source_source_author_id",
          DROP COLUMN IF EXISTS "source_source_id",
          DROP COLUMN IF EXISTS "source_source_status",
          DROP COLUMN IF EXISTS "source_source_type",
          DROP COLUMN IF EXISTS "source_system";
    ALTER TABLE "public"."orders"
          DROP COLUMN IF EXISTS "billing_address_address1",
          DROP COLUMN IF EXISTS "billing_address_address2",
          DROP COLUMN IF EXISTS "billing_address_city",
          DROP COLUMN IF EXISTS "billing_address_company",
          DROP COLUMN IF EXISTS "billing_address_country",
          DROP COLUMN IF EXISTS "billing_address_email",
          DROP COLUMN IF EXISTS "billing_address_first_name",
          DROP COLUMN IF EXISTS "billing_address_last_name",
          DROP COLUMN IF EXISTS "billing_address_phone",
          DROP COLUMN IF EXISTS "billing_address_postcode",
          DROP COLUMN IF EXISTS "billing_address_state",
          DROP COLUMN IF EXISTS "customer_id",
          DROP COLUMN IF EXISTS "customer_note",
          DROP COLUMN IF EXISTS "discount_total",
          DROP COLUMN IF EXISTS "shipping_address_address1",
          DROP COLUMN IF EXISTS "shipping_address_address2",
          DROP COLUMN IF EXISTS "shipping_address_city",
          DROP COLUMN IF EXISTS "shipping_address_company",
          DROP COLUMN IF EXISTS "shipping_address_country",
          DROP COLUMN IF EXISTS "shipping_address_email",
          DROP COLUMN IF EXISTS "shipping_address_first_name",
          DROP COLUMN IF EXISTS "shipping_address_last_name",
          DROP COLUMN IF EXISTS "shipping_address_phone",
          DROP COLUMN IF EXISTS "shipping_address_postcode",
          DROP COLUMN IF EXISTS "shipping_address_state",
          DROP COLUMN IF EXISTS "shipping_total",
          DROP COLUMN IF EXISTS "source_content_hash",
          DROP COLUMN IF EXISTS "source_installation",
          DROP COLUMN IF EXISTS "source_mapping_status",
          DROP COLUMN IF EXISTS "source_modified_at",
          DROP COLUMN IF EXISTS "source_permalink",
          DROP COLUMN IF EXISTS "source_raw_payload",
          DROP COLUMN IF EXISTS "source_source_author_id",
          DROP COLUMN IF EXISTS "source_source_id",
          DROP COLUMN IF EXISTS "source_source_status",
          DROP COLUMN IF EXISTS "source_source_type",
          DROP COLUMN IF EXISTS "source_system",
          DROP COLUMN IF EXISTS "subtotal",
          DROP COLUMN IF EXISTS "tax_total";
    ALTER TABLE "public"."pages"
          DROP COLUMN IF EXISTS "parent_id",
          DROP COLUMN IF EXISTS "source_content_hash",
          DROP COLUMN IF EXISTS "source_installation",
          DROP COLUMN IF EXISTS "source_mapping_status",
          DROP COLUMN IF EXISTS "source_modified_at",
          DROP COLUMN IF EXISTS "source_permalink",
          DROP COLUMN IF EXISTS "source_raw_payload",
          DROP COLUMN IF EXISTS "source_source_author_id",
          DROP COLUMN IF EXISTS "source_source_id",
          DROP COLUMN IF EXISTS "source_source_status",
          DROP COLUMN IF EXISTS "source_source_type",
          DROP COLUMN IF EXISTS "source_system";
    ALTER TABLE "public"."payload_locked_documents_rels"
          DROP COLUMN IF EXISTS "coupons_id",
          DROP COLUMN IF EXISTS "customers_id",
          DROP COLUMN IF EXISTS "migration_audits_id",
          DROP COLUMN IF EXISTS "migration_batches_id",
          DROP COLUMN IF EXISTS "migration_errors_id",
          DROP COLUMN IF EXISTS "migration_events_id",
          DROP COLUMN IF EXISTS "migration_jobs_id",
          DROP COLUMN IF EXISTS "migration_mappings_id",
          DROP COLUMN IF EXISTS "migration_records_id",
          DROP COLUMN IF EXISTS "migration_redirects_id",
          DROP COLUMN IF EXISTS "migration_sources_id";
    ALTER TABLE "public"."posts"
          DROP COLUMN IF EXISTS "source_content_hash",
          DROP COLUMN IF EXISTS "source_installation",
          DROP COLUMN IF EXISTS "source_mapping_status",
          DROP COLUMN IF EXISTS "source_modified_at",
          DROP COLUMN IF EXISTS "source_permalink",
          DROP COLUMN IF EXISTS "source_raw_payload",
          DROP COLUMN IF EXISTS "source_source_author_id",
          DROP COLUMN IF EXISTS "source_source_id",
          DROP COLUMN IF EXISTS "source_source_status",
          DROP COLUMN IF EXISTS "source_source_type",
          DROP COLUMN IF EXISTS "source_system";
    ALTER TABLE "public"."posts_rels"
          DROP COLUMN IF EXISTS "taxonomy_terms_id";
    ALTER TABLE "public"."products"
          DROP COLUMN IF EXISTS "canonical_url",
          DROP COLUMN IF EXISTS "downloadable",
          DROP COLUMN IF EXISTS "external_url",
          DROP COLUMN IF EXISTS "height",
          DROP COLUMN IF EXISTS "length",
          DROP COLUMN IF EXISTS "noindex",
          DROP COLUMN IF EXISTS "product_type",
          DROP COLUMN IF EXISTS "source_content_hash",
          DROP COLUMN IF EXISTS "source_installation",
          DROP COLUMN IF EXISTS "source_mapping_status",
          DROP COLUMN IF EXISTS "source_modified_at",
          DROP COLUMN IF EXISTS "source_permalink",
          DROP COLUMN IF EXISTS "source_raw_payload",
          DROP COLUMN IF EXISTS "source_source_author_id",
          DROP COLUMN IF EXISTS "source_source_id",
          DROP COLUMN IF EXISTS "source_source_status",
          DROP COLUMN IF EXISTS "source_source_type",
          DROP COLUMN IF EXISTS "source_system",
          DROP COLUMN IF EXISTS "virtual",
          DROP COLUMN IF EXISTS "weight",
          DROP COLUMN IF EXISTS "width";
    ALTER TABLE "public"."products_locales"
          DROP COLUMN IF EXISTS "body",
          DROP COLUMN IF EXISTS "button_text",
          DROP COLUMN IF EXISTS "meta_description",
          DROP COLUMN IF EXISTS "meta_title";
    DROP SEQUENCE IF EXISTS "public"."_products_v_rels_id_seq";
    DROP SEQUENCE IF EXISTS "public"."_products_v_version_attributes_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."_products_v_version_attributes_options_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."_products_v_version_variations_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."coupons_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."coupons_rels_id_seq";
    DROP SEQUENCE IF EXISTS "public"."products_attributes_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."products_attributes_options_locales_id_seq";
    DROP SEQUENCE IF EXISTS "public"."products_rels_id_seq";
    DROP SEQUENCE IF EXISTS "public"."products_variations_locales_id_seq";
    DELETE FROM "payload_jobs_log" WHERE "task_slug" = 'migrationJobs';
    DELETE FROM "payload_jobs" WHERE "task_slug" = 'migrationJobs';
    ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
    DROP TYPE IF EXISTS "public"."enum_payload_jobs_log_task_slug";
    CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'advanceDeployments', 'storageHealthCheck', 'billingIntegration', 'cdnZoneSync', 'schedulePublish');
    ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
    ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
    DROP TYPE IF EXISTS "public"."enum_payload_jobs_task_slug";
    CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'advanceDeployments', 'storageHealthCheck', 'billingIntegration', 'cdnZoneSync', 'schedulePublish');
    ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
    DROP TYPE IF EXISTS "public"."enum__pages_v_version_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum__pages_v_version_source_system";
    DROP TYPE IF EXISTS "public"."enum__posts_v_version_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum__posts_v_version_source_system";
    DROP TYPE IF EXISTS "public"."enum__products_v_version_product_type";
    DROP TYPE IF EXISTS "public"."enum__products_v_version_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum__products_v_version_source_system";
    DROP TYPE IF EXISTS "public"."enum_categories_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_categories_source_system";
    DROP TYPE IF EXISTS "public"."enum_coupons_discount_type";
    DROP TYPE IF EXISTS "public"."enum_coupons_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_coupons_source_system";
    DROP TYPE IF EXISTS "public"."enum_customers_claim_status";
    DROP TYPE IF EXISTS "public"."enum_customers_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_customers_source_system";
    DROP TYPE IF EXISTS "public"."enum_customers_status";
    DROP TYPE IF EXISTS "public"."enum_media_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_media_source_system";
    DROP TYPE IF EXISTS "public"."enum_migration_batches_status";
    DROP TYPE IF EXISTS "public"."enum_migration_errors_status";
    DROP TYPE IF EXISTS "public"."enum_migration_events_level";
    DROP TYPE IF EXISTS "public"."enum_migration_jobs_control";
    DROP TYPE IF EXISTS "public"."enum_migration_jobs_operation";
    DROP TYPE IF EXISTS "public"."enum_migration_jobs_status";
    DROP TYPE IF EXISTS "public"."enum_migration_mappings_disposition";
    DROP TYPE IF EXISTS "public"."enum_migration_mappings_status";
    DROP TYPE IF EXISTS "public"."enum_migration_records_disposition";
    DROP TYPE IF EXISTS "public"."enum_migration_redirects_status";
    DROP TYPE IF EXISTS "public"."enum_migration_sources_status";
    DROP TYPE IF EXISTS "public"."enum_orders_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_orders_source_system";
    DROP TYPE IF EXISTS "public"."enum_pages_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_pages_source_system";
    DROP TYPE IF EXISTS "public"."enum_posts_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_posts_source_system";
    DROP TYPE IF EXISTS "public"."enum_products_product_type";
    DROP TYPE IF EXISTS "public"."enum_products_source_mapping_status";
    DROP TYPE IF EXISTS "public"."enum_products_source_system";
    CREATE UNIQUE INDEX IF NOT EXISTS "redirects_from_idx" ON "public"."redirects" USING btree ("from");
  `)
}
