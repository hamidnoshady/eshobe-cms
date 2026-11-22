import type { CollectionSlug } from 'payload'

import { MCP_COLLECTION_SLUGS } from '@/plugins/mcp-slugs'

/**
 * The one description of what this deployment exposes over MCP.
 *
 * Three consumers, and they must never disagree:
 *
 *  1. `src/plugins/mcp.ts`, which turns the matrix into the plugin's
 *     `collections` option and the per-key capability checkboxes;
 *  2. `cms_describe_capabilities`, so a client can ask instead of guessing;
 *  3. `tests/int/mcp.int.spec.ts`, which pins the surface against the SDK
 *     documentation in `docs/mcp.md`.
 *
 * A capability is available only when the operation is safe for tenant content.
 * The plugin key is bound to its creating Payload user, so the multi-tenant plugin
 * scopes every operation to that user's site. **No delete operation is exposed**:
 * a destructive tool reachable by a long-lived machine credential is the one
 * mistake this surface cannot undo. Rows holding credentials, billing data,
 * user/site administration, submissions, deployments, webhooks and audit data are
 * not MCP resources at all, so they cannot be enabled by ticking a checkbox.
 */
export const MCP_OPERATIONS = ['find', 'create', 'update'] as const

export type McpOperation = (typeof MCP_OPERATIONS)[number]

export type McpCapability = Partial<Record<McpOperation | 'delete', boolean>>

export const MCP_COLLECTION_CAPABILITIES = {
  pages: { create: true, find: true, update: true },
  posts: { create: true, find: true, update: true },
  media: { find: true, update: true },
  categories: { create: true, find: true, update: true },
  'site-branding': { find: true, update: true },
  header: { find: true, update: true },
  footer: { find: true, update: true },
  products: { create: true, find: true, update: true },
  store: { find: true, update: true },
  forms: { find: true, update: true },
  'payload-folders': { create: true, find: true, update: true },
} as const satisfies Record<(typeof MCP_COLLECTION_SLUGS)[number], McpCapability>

/** There are no platform-wide globals available to MCP clients. */
export const MCP_GLOBAL_CAPABILITIES = {} as const

/**
 * Names of the custom tools registered in `src/mcp/tools`.
 *
 * Read-only on purpose. The plugin's generated key form gives every custom tool a
 * checkbox that defaults to *enabled*, so a write tool here would be granted to
 * every key the moment it was created — including a key minted for a read-only
 * assistant. Publishing and unpublishing already work through the collection
 * `update` tools, where `writeUnlessPublishing()` decides whether the caller's role
 * may publish; a second path through a custom tool would only weaken that.
 */
export const MCP_CUSTOM_TOOL_NAMES = [
  'cms_describe_capabilities',
  'cms_site_context',
  'cms_content_status',
] as const

export type McpCustomToolName = (typeof MCP_CUSTOM_TOOL_NAMES)[number]

export interface McpCollectionDescription {
  collection: CollectionSlug
  operations: McpOperation[]
}

export interface McpSurfaceDescription {
  collections: McpCollectionDescription[]
  globals: string[]
  tools: readonly McpCustomToolName[]
}

const enabledOperations = (capability: McpCapability): McpOperation[] =>
  MCP_OPERATIONS.filter((operation) => capability[operation] === true)

/**
 * The surface, derived once. Pure and payload-free so both the plugin config and
 * the discovery tool answer from the same value rather than from two hand-written
 * lists that drift.
 */
export const describeMcpSurface = (): McpSurfaceDescription => ({
  collections: MCP_COLLECTION_SLUGS.map((collection) => ({
    collection,
    operations: enabledOperations(MCP_COLLECTION_CAPABILITIES[collection]),
  })),
  globals: [],
  tools: [...MCP_CUSTOM_TOOL_NAMES],
})

/**
 * The plugin's own rule (`@payloadcms/plugin-mcp`'s `toCamelCase`), restated so the
 * capability group a key row stores and the group this app reads cannot drift.
 * `site-branding` → `siteBranding`.
 */
export const toCamelCase = (value: string): string =>
  value
    .replace(/[-_\s]+(.)?/g, (_, chr: string | undefined) => (chr ? chr.toUpperCase() : ''))
    .replace(/^(.)/, (_, chr: string) => chr.toLowerCase())
