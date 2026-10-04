import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Payload MCP keys are owned by a user. Deleting that user must revoke/delete the
 * credential, not set the non-null owner FK to NULL (the previous generated DDL could
 * never satisfy both constraints).
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_mcp_api_keys"
      DROP CONSTRAINT IF EXISTS "payload_mcp_api_keys_user_id_users_id_fk";
    ALTER TABLE "payload_mcp_api_keys"
      ADD CONSTRAINT "payload_mcp_api_keys_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE cascade ON UPDATE no action;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_mcp_api_keys"
      DROP CONSTRAINT IF EXISTS "payload_mcp_api_keys_user_id_users_id_fk";
    ALTER TABLE "payload_mcp_api_keys"
      ADD CONSTRAINT "payload_mcp_api_keys_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
      ON DELETE set null ON UPDATE no action;
  `)
}
