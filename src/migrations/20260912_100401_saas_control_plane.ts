import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_plans_currency" AS ENUM('EUR', 'IRR', 'IRT', 'USD');
  CREATE TYPE "public"."enum_plans_interval" AS ENUM('monthly', 'quarterly', 'yearly', 'lifetime');
  CREATE TYPE "public"."enum_subscriptions_status" AS ENUM('trialing', 'active', 'pastDue', 'suspended', 'cancelled', 'expired');
  CREATE TYPE "public"."enum_invoices_status" AS ENUM('draft', 'issued', 'paid', 'void', 'uncollectible');
  CREATE TYPE "public"."enum_invoices_currency" AS ENUM('EUR', 'IRR', 'IRT', 'USD');
  CREATE TYPE "public"."enum_site_entitlements_quota_enforcement" AS ENUM('inherit', 'warn', 'enforce', 'off');
  CREATE TYPE "public"."enum_usage_records_metric" AS ENUM('pages', 'posts', 'products', 'media', 'mediaStorageMb', 'categories', 'users', 'apiKeys', 'ordersPerMonth', 'apiRequestsPerMonth', 'domains');
  CREATE TYPE "public"."enum_feature_flags_category" AS ENUM('general', 'content', 'commerce', 'infrastructure', 'integration');
  CREATE TYPE "public"."enum_plugins_type" AS ENUM('analytics', 'chat', 'headScript', 'webhook', 'buildHook', 'email', 'seo', 'translation', 'backup', 'custom');
  CREATE TYPE "public"."enum_plugins_scope" AS ENUM('global', 'sites');
  CREATE TYPE "public"."enum_theme_templates_site_types" AS ENUM('business', 'portfolio', 'store');
  CREATE TYPE "public"."enum_theme_templates_tokens_radius" AS ENUM('none', 'sm', 'md', 'lg');
  CREATE TYPE "public"."enum_webhooks_events" AS ENUM('site.created', 'site.updated', 'site.suspended', 'site.resumed', 'site.deleted', 'domain.changed', 'domain.verified', 'subscription.created', 'subscription.changed', 'subscription.cancelled', 'subscription.expired', 'invoice.issued', 'invoice.paid', 'invoice.overdue', 'quota.warning', 'quota.exceeded', 'apikey.issued', 'apikey.revoked', 'plugin.changed', 'storage.changed', 'cdn.synced', 'order.paid', 'backup.completed', 'platform.settingsChanged');
  CREATE TYPE "public"."enum_webhook_deliveries_event" AS ENUM('site.created', 'site.updated', 'site.suspended', 'site.resumed', 'site.deleted', 'domain.changed', 'domain.verified', 'subscription.created', 'subscription.changed', 'subscription.cancelled', 'subscription.expired', 'invoice.issued', 'invoice.paid', 'invoice.overdue', 'quota.warning', 'quota.exceeded', 'apikey.issued', 'apikey.revoked', 'plugin.changed', 'storage.changed', 'cdn.synced', 'order.paid', 'backup.completed', 'platform.settingsChanged');
  CREATE TYPE "public"."enum_audit_log_action" AS ENUM('site.created', 'site.updated', 'site.suspended', 'site.resumed', 'site.deleted', 'domain.changed', 'domain.verified', 'subscription.created', 'subscription.changed', 'subscription.cancelled', 'subscription.expired', 'invoice.issued', 'invoice.paid', 'invoice.overdue', 'quota.warning', 'quota.exceeded', 'apikey.issued', 'apikey.revoked', 'plugin.changed', 'storage.changed', 'cdn.synced', 'order.paid', 'backup.completed', 'platform.settingsChanged');
  CREATE TYPE "public"."enum_audit_log_actor_type" AS ENUM('user', 'apiKey', 'system');
  CREATE TYPE "public"."enum_platform_settings_default_site_status" AS ENUM('active', 'suspended');
  CREATE TYPE "public"."enum_platform_settings_quota_enforcement" AS ENUM('warn', 'enforce', 'off');
  CREATE TABLE "plans" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"code" varchar NOT NULL,
  	"description" varchar,
  	"price" numeric DEFAULT 0 NOT NULL,
  	"currency" "enum_plans_currency" DEFAULT 'IRT' NOT NULL,
  	"interval" "enum_plans_interval" DEFAULT 'monthly' NOT NULL,
  	"trial_days" numeric DEFAULT 0,
  	"active" boolean DEFAULT true,
  	"public" boolean DEFAULT true,
  	"sort_order" numeric DEFAULT 100,
  	"limits_pages" numeric,
  	"limits_posts" numeric,
  	"limits_products" numeric,
  	"limits_media" numeric,
  	"limits_media_storage_mb" numeric,
  	"limits_categories" numeric,
  	"limits_users" numeric,
  	"limits_api_keys" numeric,
  	"limits_orders_per_month" numeric,
  	"limits_api_requests_per_month" numeric,
  	"limits_domains" numeric,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "plans_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" uuid NOT NULL,
  	"path" varchar NOT NULL,
  	"feature_flags_id" uuid
  );
  
  CREATE TABLE "subscriptions" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"reference" varchar,
  	"plan_id" uuid NOT NULL,
  	"status" "enum_subscriptions_status" DEFAULT 'trialing' NOT NULL,
  	"auto_renew" boolean DEFAULT true,
  	"started_at" timestamp(3) with time zone,
  	"current_period_start" timestamp(3) with time zone,
  	"current_period_end" timestamp(3) with time zone,
  	"trial_ends_at" timestamp(3) with time zone,
  	"cancelled_at" timestamp(3) with time zone,
  	"limit_overrides" jsonb,
  	"notes" varchar,
  	"entitled" boolean,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "invoices_lines" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"description" varchar NOT NULL,
  	"quantity" numeric DEFAULT 1 NOT NULL,
  	"unit_amount" numeric DEFAULT 0 NOT NULL,
  	"amount" numeric
  );
  
  CREATE TABLE "invoices" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"number" varchar,
  	"status" "enum_invoices_status" DEFAULT 'draft' NOT NULL,
  	"subscription_id" uuid,
  	"issued_at" timestamp(3) with time zone,
  	"due_at" timestamp(3) with time zone,
  	"paid_at" timestamp(3) with time zone,
  	"currency" "enum_invoices_currency" DEFAULT 'IRT' NOT NULL,
  	"discount" numeric DEFAULT 0,
  	"tax_percent" numeric DEFAULT 0,
  	"subtotal" numeric,
  	"tax" numeric,
  	"total" numeric,
  	"payment_reference" varchar,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_entitlements_features" (
  	"_order" integer NOT NULL,
  	"_parent_id" uuid NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"feature_id" uuid NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"reason" varchar
  );
  
  CREATE TABLE "site_entitlements" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"limit_overrides_pages" numeric,
  	"limit_overrides_posts" numeric,
  	"limit_overrides_products" numeric,
  	"limit_overrides_media" numeric,
  	"limit_overrides_media_storage_mb" numeric,
  	"limit_overrides_categories" numeric,
  	"limit_overrides_users" numeric,
  	"limit_overrides_api_keys" numeric,
  	"limit_overrides_orders_per_month" numeric,
  	"limit_overrides_api_requests_per_month" numeric,
  	"limit_overrides_domains" numeric,
  	"quota_enforcement" "enum_site_entitlements_quota_enforcement" DEFAULT 'inherit' NOT NULL,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "usage_records" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"site_id" uuid,
  	"metric" "enum_usage_records_metric" NOT NULL,
  	"period" varchar NOT NULL,
  	"value" numeric DEFAULT 0 NOT NULL,
  	"last_event_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "feature_flags" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"key" varchar NOT NULL,
  	"label" varchar NOT NULL,
  	"category" "enum_feature_flags_category" DEFAULT 'general',
  	"default_enabled" boolean DEFAULT false,
  	"description" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "plugins" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"key" varchar NOT NULL,
  	"type" "enum_plugins_type" NOT NULL,
  	"enabled" boolean DEFAULT false,
  	"version" varchar,
  	"scope" "enum_plugins_scope" DEFAULT 'global' NOT NULL,
  	"settings" jsonb,
  	"credential" varchar,
  	"clear_credential" boolean DEFAULT false,
  	"credentials_summary" varchar,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "plugins_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" uuid NOT NULL,
  	"path" varchar NOT NULL,
  	"sites_id" uuid
  );
  
  CREATE TABLE "theme_templates_site_types" (
  	"order" integer NOT NULL,
  	"parent_id" uuid NOT NULL,
  	"value" "enum_theme_templates_site_types",
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
  );
  
  CREATE TABLE "theme_templates" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"key" varchar NOT NULL,
  	"description" varchar,
  	"active" boolean DEFAULT true,
  	"is_default" boolean DEFAULT false,
  	"tokens_primary" varchar DEFAULT '#0f766e',
  	"tokens_accent" varchar DEFAULT '#f59e0b',
  	"tokens_background" varchar DEFAULT '#ffffff',
  	"tokens_foreground" varchar DEFAULT '#0a0a0a',
  	"tokens_radius" "enum_theme_templates_tokens_radius" DEFAULT 'md',
  	"tokens_line_height" numeric DEFAULT 1.8,
  	"preview_id" uuid,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "webhooks_events" (
  	"order" integer NOT NULL,
  	"parent_id" uuid NOT NULL,
  	"value" "enum_webhooks_events",
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
  );
  
  CREATE TABLE "webhooks" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"name" varchar NOT NULL,
  	"url" varchar NOT NULL,
  	"enabled" boolean DEFAULT true,
  	"site_id" uuid,
  	"secret" varchar,
  	"clear_secret" boolean DEFAULT false,
  	"secret_summary" varchar,
  	"last_delivery_at" timestamp(3) with time zone,
  	"last_delivery_ok" boolean,
  	"consecutive_failures" numeric DEFAULT 0,
  	"last_error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "webhook_deliveries" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"webhook_id" uuid,
  	"event" "enum_webhook_deliveries_event" NOT NULL,
  	"ok" boolean DEFAULT false NOT NULL,
  	"status_code" numeric,
  	"duration_ms" numeric,
  	"attempt" numeric DEFAULT 1,
  	"request_body" jsonb,
  	"response_body" varchar,
  	"error" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "audit_log" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"action" "enum_audit_log_action" NOT NULL,
  	"summary" varchar NOT NULL,
  	"actor_type" "enum_audit_log_actor_type" DEFAULT 'user' NOT NULL,
  	"actor_email" varchar,
  	"ip" varchar,
  	"site_id" uuid,
  	"target_collection" varchar,
  	"target_id" varchar,
  	"changes" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "platform_settings" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"platform_name" varchar DEFAULT 'اشوبه',
  	"support_email" varchar,
  	"support_url" varchar,
  	"billing_email" varchar,
  	"signups_open" boolean DEFAULT false,
  	"default_plan_id" uuid,
  	"default_site_status" "enum_platform_settings_default_site_status" DEFAULT 'active',
  	"max_sites_per_user" numeric,
  	"quota_enforcement" "enum_platform_settings_quota_enforcement" DEFAULT 'warn' NOT NULL,
  	"quota_warn_percent" numeric DEFAULT 80,
  	"suspend_on_quota_exceeded" boolean DEFAULT false,
  	"invoice_due_days" numeric DEFAULT 7,
  	"tax_percent" numeric DEFAULT 0,
  	"auto_renew_invoices" boolean DEFAULT true,
  	"invoice_footer" varchar,
  	"maintenance_mode" boolean DEFAULT false,
  	"maintenance_message" varchar,
  	"webhook_max_failures" numeric DEFAULT 10,
  	"webhook_timeout_ms" numeric DEFAULT 5000,
  	"audit_retention_days" numeric DEFAULT 365,
  	"delivery_retention_days" numeric DEFAULT 30,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "plans_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "subscriptions_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "invoices_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "site_entitlements_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "usage_records_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "feature_flags_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "plugins_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "theme_templates_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "webhooks_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "webhook_deliveries_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "audit_log_id" uuid;
  ALTER TABLE "plans_rels" ADD CONSTRAINT "plans_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "plans_rels" ADD CONSTRAINT "plans_rels_feature_flags_fk" FOREIGN KEY ("feature_flags_id") REFERENCES "public"."feature_flags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invoices_lines" ADD CONSTRAINT "invoices_lines_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_entitlements_features" ADD CONSTRAINT "site_entitlements_features_feature_id_feature_flags_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."feature_flags"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "site_entitlements_features" ADD CONSTRAINT "site_entitlements_features_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."site_entitlements"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "site_entitlements" ADD CONSTRAINT "site_entitlements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "plugins_rels" ADD CONSTRAINT "plugins_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "plugins_rels" ADD CONSTRAINT "plugins_rels_sites_fk" FOREIGN KEY ("sites_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "theme_templates_site_types" ADD CONSTRAINT "theme_templates_site_types_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."theme_templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "theme_templates" ADD CONSTRAINT "theme_templates_preview_id_media_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "webhooks_events" ADD CONSTRAINT "webhooks_events_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_default_plan_id_plans_id_fk" FOREIGN KEY ("default_plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "plans_code_idx" ON "plans" USING btree ("code");
  CREATE INDEX "plans_updated_at_idx" ON "plans" USING btree ("updated_at");
  CREATE INDEX "plans_created_at_idx" ON "plans" USING btree ("created_at");
  CREATE INDEX "plans_rels_order_idx" ON "plans_rels" USING btree ("order");
  CREATE INDEX "plans_rels_parent_idx" ON "plans_rels" USING btree ("parent_id");
  CREATE INDEX "plans_rels_path_idx" ON "plans_rels" USING btree ("path");
  CREATE INDEX "plans_rels_feature_flags_id_idx" ON "plans_rels" USING btree ("feature_flags_id");
  CREATE INDEX "subscriptions_site_idx" ON "subscriptions" USING btree ("site_id");
  CREATE INDEX "subscriptions_reference_idx" ON "subscriptions" USING btree ("reference");
  CREATE INDEX "subscriptions_plan_idx" ON "subscriptions" USING btree ("plan_id");
  CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");
  CREATE INDEX "subscriptions_current_period_end_idx" ON "subscriptions" USING btree ("current_period_end");
  CREATE INDEX "subscriptions_updated_at_idx" ON "subscriptions" USING btree ("updated_at");
  CREATE INDEX "subscriptions_created_at_idx" ON "subscriptions" USING btree ("created_at");
  CREATE INDEX "invoices_lines_order_idx" ON "invoices_lines" USING btree ("_order");
  CREATE INDEX "invoices_lines_parent_id_idx" ON "invoices_lines" USING btree ("_parent_id");
  CREATE INDEX "invoices_site_idx" ON "invoices" USING btree ("site_id");
  CREATE UNIQUE INDEX "invoices_number_idx" ON "invoices" USING btree ("number");
  CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");
  CREATE INDEX "invoices_subscription_idx" ON "invoices" USING btree ("subscription_id");
  CREATE INDEX "invoices_due_at_idx" ON "invoices" USING btree ("due_at");
  CREATE INDEX "invoices_total_idx" ON "invoices" USING btree ("total");
  CREATE INDEX "invoices_updated_at_idx" ON "invoices" USING btree ("updated_at");
  CREATE INDEX "invoices_created_at_idx" ON "invoices" USING btree ("created_at");
  CREATE INDEX "site_entitlements_features_order_idx" ON "site_entitlements_features" USING btree ("_order");
  CREATE INDEX "site_entitlements_features_parent_id_idx" ON "site_entitlements_features" USING btree ("_parent_id");
  CREATE INDEX "site_entitlements_features_feature_idx" ON "site_entitlements_features" USING btree ("feature_id");
  CREATE UNIQUE INDEX "site_entitlements_site_idx" ON "site_entitlements" USING btree ("site_id");
  CREATE INDEX "site_entitlements_updated_at_idx" ON "site_entitlements" USING btree ("updated_at");
  CREATE INDEX "site_entitlements_created_at_idx" ON "site_entitlements" USING btree ("created_at");
  CREATE INDEX "usage_records_site_idx" ON "usage_records" USING btree ("site_id");
  CREATE INDEX "usage_records_metric_idx" ON "usage_records" USING btree ("metric");
  CREATE INDEX "usage_records_period_idx" ON "usage_records" USING btree ("period");
  CREATE INDEX "usage_records_updated_at_idx" ON "usage_records" USING btree ("updated_at");
  CREATE INDEX "usage_records_created_at_idx" ON "usage_records" USING btree ("created_at");
  CREATE UNIQUE INDEX "feature_flags_key_idx" ON "feature_flags" USING btree ("key");
  CREATE INDEX "feature_flags_updated_at_idx" ON "feature_flags" USING btree ("updated_at");
  CREATE INDEX "feature_flags_created_at_idx" ON "feature_flags" USING btree ("created_at");
  CREATE UNIQUE INDEX "plugins_key_idx" ON "plugins" USING btree ("key");
  CREATE INDEX "plugins_type_idx" ON "plugins" USING btree ("type");
  CREATE INDEX "plugins_enabled_idx" ON "plugins" USING btree ("enabled");
  CREATE INDEX "plugins_updated_at_idx" ON "plugins" USING btree ("updated_at");
  CREATE INDEX "plugins_created_at_idx" ON "plugins" USING btree ("created_at");
  CREATE INDEX "plugins_rels_order_idx" ON "plugins_rels" USING btree ("order");
  CREATE INDEX "plugins_rels_parent_idx" ON "plugins_rels" USING btree ("parent_id");
  CREATE INDEX "plugins_rels_path_idx" ON "plugins_rels" USING btree ("path");
  CREATE INDEX "plugins_rels_sites_id_idx" ON "plugins_rels" USING btree ("sites_id");
  CREATE INDEX "theme_templates_site_types_order_idx" ON "theme_templates_site_types" USING btree ("order");
  CREATE INDEX "theme_templates_site_types_parent_idx" ON "theme_templates_site_types" USING btree ("parent_id");
  CREATE UNIQUE INDEX "theme_templates_key_idx" ON "theme_templates" USING btree ("key");
  CREATE INDEX "theme_templates_preview_idx" ON "theme_templates" USING btree ("preview_id");
  CREATE INDEX "theme_templates_updated_at_idx" ON "theme_templates" USING btree ("updated_at");
  CREATE INDEX "theme_templates_created_at_idx" ON "theme_templates" USING btree ("created_at");
  CREATE INDEX "webhooks_events_order_idx" ON "webhooks_events" USING btree ("order");
  CREATE INDEX "webhooks_events_parent_idx" ON "webhooks_events" USING btree ("parent_id");
  CREATE INDEX "webhooks_enabled_idx" ON "webhooks" USING btree ("enabled");
  CREATE INDEX "webhooks_site_idx" ON "webhooks" USING btree ("site_id");
  CREATE INDEX "webhooks_updated_at_idx" ON "webhooks" USING btree ("updated_at");
  CREATE INDEX "webhooks_created_at_idx" ON "webhooks" USING btree ("created_at");
  CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");
  CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event");
  CREATE INDEX "webhook_deliveries_ok_idx" ON "webhook_deliveries" USING btree ("ok");
  CREATE INDEX "webhook_deliveries_updated_at_idx" ON "webhook_deliveries" USING btree ("updated_at");
  CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");
  CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");
  CREATE INDEX "audit_log_actor_email_idx" ON "audit_log" USING btree ("actor_email");
  CREATE INDEX "audit_log_site_idx" ON "audit_log" USING btree ("site_id");
  CREATE INDEX "audit_log_target_id_idx" ON "audit_log" USING btree ("target_id");
  CREATE INDEX "audit_log_updated_at_idx" ON "audit_log" USING btree ("updated_at");
  CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at");
  CREATE INDEX "platform_settings_default_plan_idx" ON "platform_settings" USING btree ("default_plan_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_plans_fk" FOREIGN KEY ("plans_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_subscriptions_fk" FOREIGN KEY ("subscriptions_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_invoices_fk" FOREIGN KEY ("invoices_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_entitlements_fk" FOREIGN KEY ("site_entitlements_id") REFERENCES "public"."site_entitlements"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_usage_records_fk" FOREIGN KEY ("usage_records_id") REFERENCES "public"."usage_records"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_feature_flags_fk" FOREIGN KEY ("feature_flags_id") REFERENCES "public"."feature_flags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_plugins_fk" FOREIGN KEY ("plugins_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_theme_templates_fk" FOREIGN KEY ("theme_templates_id") REFERENCES "public"."theme_templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_webhooks_fk" FOREIGN KEY ("webhooks_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_webhook_deliveries_fk" FOREIGN KEY ("webhook_deliveries_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_audit_log_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_log"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_plans_id_idx" ON "payload_locked_documents_rels" USING btree ("plans_id");
  CREATE INDEX "payload_locked_documents_rels_subscriptions_id_idx" ON "payload_locked_documents_rels" USING btree ("subscriptions_id");
  CREATE INDEX "payload_locked_documents_rels_invoices_id_idx" ON "payload_locked_documents_rels" USING btree ("invoices_id");
  CREATE INDEX "payload_locked_documents_rels_site_entitlements_id_idx" ON "payload_locked_documents_rels" USING btree ("site_entitlements_id");
  CREATE INDEX "payload_locked_documents_rels_usage_records_id_idx" ON "payload_locked_documents_rels" USING btree ("usage_records_id");
  CREATE INDEX "payload_locked_documents_rels_feature_flags_id_idx" ON "payload_locked_documents_rels" USING btree ("feature_flags_id");
  CREATE INDEX "payload_locked_documents_rels_plugins_id_idx" ON "payload_locked_documents_rels" USING btree ("plugins_id");
  CREATE INDEX "payload_locked_documents_rels_theme_templates_id_idx" ON "payload_locked_documents_rels" USING btree ("theme_templates_id");
  CREATE INDEX "payload_locked_documents_rels_webhooks_id_idx" ON "payload_locked_documents_rels" USING btree ("webhooks_id");
  CREATE INDEX "payload_locked_documents_rels_webhook_deliveries_id_idx" ON "payload_locked_documents_rels" USING btree ("webhook_deliveries_id");
  CREATE INDEX "payload_locked_documents_rels_audit_log_id_idx" ON "payload_locked_documents_rels" USING btree ("audit_log_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "plans" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "plans_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "subscriptions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invoices_lines" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invoices" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_entitlements_features" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "site_entitlements" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "usage_records" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "feature_flags" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "plugins" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "plugins_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "theme_templates_site_types" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "theme_templates" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "webhooks_events" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "webhooks" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "webhook_deliveries" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "audit_log" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "platform_settings" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "plans" CASCADE;
  DROP TABLE "plans_rels" CASCADE;
  DROP TABLE "subscriptions" CASCADE;
  DROP TABLE "invoices_lines" CASCADE;
  DROP TABLE "invoices" CASCADE;
  DROP TABLE "site_entitlements_features" CASCADE;
  DROP TABLE "site_entitlements" CASCADE;
  DROP TABLE "usage_records" CASCADE;
  DROP TABLE "feature_flags" CASCADE;
  DROP TABLE "plugins" CASCADE;
  DROP TABLE "plugins_rels" CASCADE;
  DROP TABLE "theme_templates_site_types" CASCADE;
  DROP TABLE "theme_templates" CASCADE;
  DROP TABLE "webhooks_events" CASCADE;
  DROP TABLE "webhooks" CASCADE;
  DROP TABLE "webhook_deliveries" CASCADE;
  DROP TABLE "audit_log" CASCADE;
  DROP TABLE "platform_settings" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_plans_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_subscriptions_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_invoices_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_site_entitlements_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_usage_records_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_feature_flags_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_plugins_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_theme_templates_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_webhooks_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_webhook_deliveries_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_audit_log_fk";
  
  DROP INDEX "payload_locked_documents_rels_plans_id_idx";
  DROP INDEX "payload_locked_documents_rels_subscriptions_id_idx";
  DROP INDEX "payload_locked_documents_rels_invoices_id_idx";
  DROP INDEX "payload_locked_documents_rels_site_entitlements_id_idx";
  DROP INDEX "payload_locked_documents_rels_usage_records_id_idx";
  DROP INDEX "payload_locked_documents_rels_feature_flags_id_idx";
  DROP INDEX "payload_locked_documents_rels_plugins_id_idx";
  DROP INDEX "payload_locked_documents_rels_theme_templates_id_idx";
  DROP INDEX "payload_locked_documents_rels_webhooks_id_idx";
  DROP INDEX "payload_locked_documents_rels_webhook_deliveries_id_idx";
  DROP INDEX "payload_locked_documents_rels_audit_log_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "plans_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "subscriptions_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "invoices_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "site_entitlements_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "usage_records_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "feature_flags_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "plugins_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "theme_templates_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "webhooks_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "webhook_deliveries_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "audit_log_id";
  DROP TYPE "public"."enum_plans_currency";
  DROP TYPE "public"."enum_plans_interval";
  DROP TYPE "public"."enum_subscriptions_status";
  DROP TYPE "public"."enum_invoices_status";
  DROP TYPE "public"."enum_invoices_currency";
  DROP TYPE "public"."enum_site_entitlements_quota_enforcement";
  DROP TYPE "public"."enum_usage_records_metric";
  DROP TYPE "public"."enum_feature_flags_category";
  DROP TYPE "public"."enum_plugins_type";
  DROP TYPE "public"."enum_plugins_scope";
  DROP TYPE "public"."enum_theme_templates_site_types";
  DROP TYPE "public"."enum_theme_templates_tokens_radius";
  DROP TYPE "public"."enum_webhooks_events";
  DROP TYPE "public"."enum_webhook_deliveries_event";
  DROP TYPE "public"."enum_audit_log_action";
  DROP TYPE "public"."enum_audit_log_actor_type";
  DROP TYPE "public"."enum_platform_settings_default_site_status";
  DROP TYPE "public"."enum_platform_settings_quota_enforcement";`)
}
