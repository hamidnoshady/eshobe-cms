import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Café checkout (ESH-150): service mode, an opaque table token, pay-at-counter, the
 * `order.submitted` event and the POS's fulfillment lifecycle.
 *
 * ## The one structural rule
 *
 * `orders.status` stays the **payment** lifecycle. The kitchen's state is a second,
 * independent column (`orders.cafe_fulfillment`) because a pay-at-counter order is
 * unpaid *and* accepted, and a paid order can still be rejected — one enum cannot hold
 * both without one of those states becoming unrepresentable.
 *
 * ## The unique index is load-bearing, not an optimisation
 *
 * `(site_id, checkout_request_id)` is what makes a checkout retry return the order it
 * already created instead of a second one, *including* when two retries arrive at once:
 * the loser of that race gets a `23505` and the endpoint re-reads the winner. A
 * non-unique index would leave the duplicate invisible until a guest got two coffees.
 * PostgreSQL allows any number of `NULL`s in a unique index, so every existing order
 * (none of which carries a key) is unaffected.
 *
 * Additive and idempotent: `ADD COLUMN IF NOT EXISTS`, `ADD VALUE IF NOT EXISTS`, and
 * `CREATE INDEX IF NOT EXISTS`. Re-running it on a database that already has the shape
 * is a no-op rather than an error, and the enum value is added before anything writes it.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    -- PostgreSQL has no CREATE TYPE IF NOT EXISTS, and a dollar-quoted DO block cannot
    -- survive a tagged template literal (its delimiter is the same character as the
    -- template's own substitution syntax). A catalog guard is the equivalent that stays
    -- plain SQL: run the DDL, or run nothing.
    CREATE OR REPLACE FUNCTION pg_temp.cafe_ensure_enum(name text, labels text[]) RETURNS void
      LANGUAGE plpgsql AS $body$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = name AND n.nspname = 'public') THEN
          EXECUTE format('CREATE TYPE "public".%I AS ENUM (%s)', name, array_to_string(array_quote_literal(labels), ', '));
        END IF;
      END
      $body$;

    SELECT pg_temp.cafe_ensure_enum('enum_orders_cafe_service_mode', ARRAY['dine_in', 'takeaway']);
    SELECT pg_temp.cafe_ensure_enum('enum_orders_cafe_payment_choice', ARRAY['online', 'counter']);
    SELECT pg_temp.cafe_ensure_enum('enum_orders_cafe_fulfillment', ARRAY['awaiting_approval', 'accepted', 'preparing', 'ready', 'served', 'rejected']);

    -- counter is a payment *method* (like bank), so it lives on the same column the
    -- gateways already use. Added to both enums: an order names it, and a site may be
    -- configured to default to it.
    ALTER TYPE "public"."enum_orders_payment_provider" ADD VALUE IF NOT EXISTS 'counter';
    ALTER TYPE "public"."enum_store_payment_provider" ADD VALUE IF NOT EXISTS 'counter';

    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_service_mode" "enum_orders_cafe_service_mode";
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_table_token" varchar;
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_payment_choice" "enum_orders_cafe_payment_choice";
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_checkout_request_id" varchar;
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_cart_fingerprint" varchar;
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_fulfillment" "enum_orders_cafe_fulfillment" DEFAULT 'awaiting_approval';
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_fulfillment_at" timestamp(3) with time zone;

    CREATE INDEX IF NOT EXISTS "orders_cafe_service_mode_idx" ON "orders" ("cafe_service_mode");
    CREATE INDEX IF NOT EXISTS "orders_cafe_fulfillment_idx" ON "orders" ("cafe_fulfillment");
    CREATE INDEX IF NOT EXISTS "orders_cafe_checkout_request_id_idx" ON "orders" ("cafe_checkout_request_id");
    -- The name is what Payload's schema builder generates for a compound index on
    -- (site, cafe.checkoutRequestId): each index path with dots turned into
    -- underscores, joined with underscores, then the _idx suffix. camelCase is
    -- preserved, so the result is site_cafe_checkoutRequestId_idx - the same
    -- convention as site_cafeMenuIdentity_idx and
    -- site_menuSourceSystem_menuSourceId_1_idx in the cafe-menu migration. Getting
    -- this wrong makes a dev-mode schema push drop and recreate the index, which
    -- re-runs the unique constraint build on a live table.
    CREATE UNIQUE INDEX IF NOT EXISTS "site_cafe_checkoutRequestId_idx" ON "orders" ("site_id", "cafe_checkout_request_id");

    -- The platform event vocabulary gained one value on three closed enums.
    ALTER TYPE "public"."enum_webhooks_events" ADD VALUE IF NOT EXISTS 'order.submitted';
    ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE IF NOT EXISTS 'order.submitted';
    ALTER TYPE "public"."enum_audit_log_action" ADD VALUE IF NOT EXISTS 'order.submitted';
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP INDEX IF EXISTS "orders_cafe_checkout_request_id_idx";
    DROP INDEX IF EXISTS "orders_cafe_fulfillment_idx";
    DROP INDEX IF EXISTS "orders_cafe_service_mode_idx";
    DROP INDEX IF EXISTS "site_cafe_checkoutRequestId_idx";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_fulfillment_at";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_fulfillment";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_cart_fingerprint";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_checkout_request_id";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_payment_choice";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_table_token";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_service_mode";
    DROP TYPE IF EXISTS "enum_orders_cafe_fulfillment";
    DROP TYPE IF EXISTS "enum_orders_cafe_payment_choice";
    DROP TYPE IF EXISTS "enum_orders_cafe_service_mode";
    -- Enum values cannot be removed safely once used; counter and order.submitted
    -- stay in their types on a rollback, exactly as order.refunded does.
  `)
}
