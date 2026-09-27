import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE IF NOT EXISTS 'order.refunded' AFTER 'order.paid';
  ALTER TYPE "public"."enum_webhooks_events" ADD VALUE IF NOT EXISTS 'order.cancelled' AFTER 'order.refunded';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE IF NOT EXISTS 'order.refunded' AFTER 'order.paid';
  ALTER TYPE "public"."enum_webhook_deliveries_event" ADD VALUE IF NOT EXISTS 'order.cancelled' AFTER 'order.refunded';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE IF NOT EXISTS 'order.refunded' AFTER 'order.paid';
  ALTER TYPE "public"."enum_audit_log_action" ADD VALUE IF NOT EXISTS 'order.cancelled' AFTER 'order.refunded';
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Enum values cannot be removed safely once used.
  await db.execute(sql`SELECT 1`)
}
