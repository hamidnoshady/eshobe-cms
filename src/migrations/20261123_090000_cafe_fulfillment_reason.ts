import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * The café's reason for rejecting an order.
 *
 * The POS has recorded it since the approval flow shipped, but the CMS had no
 * column for it, so the state call carried only `rejected` and every receipt
 * said «رد شد» with no explanation (production: a test order rejected with
 * «نداریم» showed nothing on the buyer's invoice).
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cafe_fulfillment_reason" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`ALTER TABLE "orders" DROP COLUMN IF EXISTS "cafe_fulfillment_reason";`)
}
