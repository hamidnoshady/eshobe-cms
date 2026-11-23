import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * The MCP plugin stores custom-tool grants on each API key. These fields were
 * added to the collection config, but the checked-in migration history never
 * added their columns to existing databases. A full key-list query then failed
 * when Payload selected the group, leaving the MCP Keys admin page blank.
 *
 * The plugin defaults custom tools to enabled. Keep that behavior for existing
 * keys while making the schema addition safe to re-run on partially migrated
 * installations.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_mcp_api_keys"
      ADD COLUMN IF NOT EXISTS "payload_mcp_tool_cms_describe_capabilities" boolean DEFAULT true;
    ALTER TABLE "payload_mcp_api_keys"
      ADD COLUMN IF NOT EXISTS "payload_mcp_tool_cms_site_context" boolean DEFAULT true;
    ALTER TABLE "payload_mcp_api_keys"
      ADD COLUMN IF NOT EXISTS "payload_mcp_tool_cms_content_status" boolean DEFAULT true;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_mcp_api_keys"
      DROP COLUMN IF EXISTS "payload_mcp_tool_cms_describe_capabilities";
    ALTER TABLE "payload_mcp_api_keys"
      DROP COLUMN IF EXISTS "payload_mcp_tool_cms_site_context";
    ALTER TABLE "payload_mcp_api_keys"
      DROP COLUMN IF EXISTS "payload_mcp_tool_cms_content_status";
  `)
}
