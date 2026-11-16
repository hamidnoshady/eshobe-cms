import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TYPE "public"."enum_orders_cafe_fulfillment" ADD VALUE IF NOT EXISTS 'cancelled';
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_table_label" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Keep the additive enum label so rolling back preserves existing order history.
  await db.execute(sql`ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_table_label";`)
}
