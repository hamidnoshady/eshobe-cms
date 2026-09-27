import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Rename the storage integral meter to the canonical billing-contract key.
 * Safe when the execution-plane migration already created `media.storage_byte_hour`.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'enum_billing_usage_outbox_meter_key'
          AND e.enumlabel = 'media.storage_byte_hour'
      ) THEN
        ALTER TYPE "public"."enum_billing_usage_outbox_meter_key"
          RENAME VALUE 'media.storage_byte_hour' TO 'cms.storage_byte_hour';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'enum_billing_usage_samples_meter_key'
          AND e.enumlabel = 'media.storage_byte_hour'
      ) THEN
        ALTER TYPE "public"."enum_billing_usage_samples_meter_key"
          RENAME VALUE 'media.storage_byte_hour' TO 'cms.storage_byte_hour';
      END IF;
    END $$;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'enum_billing_usage_outbox_meter_key'
          AND e.enumlabel = 'cms.storage_byte_hour'
      ) THEN
        ALTER TYPE "public"."enum_billing_usage_outbox_meter_key"
          RENAME VALUE 'cms.storage_byte_hour' TO 'media.storage_byte_hour';
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'enum_billing_usage_samples_meter_key'
          AND e.enumlabel = 'cms.storage_byte_hour'
      ) THEN
        ALTER TYPE "public"."enum_billing_usage_samples_meter_key"
          RENAME VALUE 'cms.storage_byte_hour' TO 'media.storage_byte_hour';
      END IF;
    END $$;
  `)
}
