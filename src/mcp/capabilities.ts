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
 *  3. `tests/int/mcp.int.spec.ts`, which pins the surface against the
 *     documentation in `docs/mcp.md`.
 *
 * ## What is exposed
 *
 * The tenant's own site: content, design and commerce reads. That is the same set
 * of collections an editor sees in the admin panel, minus everything that
 * administers the *platform* rather than the site.
 *
 * ## Delete is opt-in, per key
 *
 * `delete: true` in a row does **not** grant deletion to anyone. It makes a
 * "delete" checkbox appear on the key form, and the plugin's checkboxes default
 * to **off** — so a key can delete a page only if somebody explicitly ticked
 * that box while minting it. The rows that carry it are content rows, where
 * deletion is an ordinary editor action and the audit hook records it.
 *
 * The rows that deliberately have no delete are the ones where the loss is not
 * content: `orders` (a sale is evidence), `sites` (the tenant's identity),
 * `theme` / `site-branding` / `header` / `footer` / `store` (singletons whose
 * "delete" means breaking the site), `forms` (submissions outlive the form), and
 * the two definition collections (`content-type-definitions`,
 * `taxonomy-definitions`), whose deletion cascades through entries and terms.
 *
 * ## What is never exposed
 *
 * `users` (staff accounts and roles — an assistant must not be able to mint an
 * owner), `api-keys`, credential collections, billing, `webhooks`, `audit-log`,
 * `form-submissions`, `site-theme-settings` (which holds secret answers), and
 * every deployment/theme-package table. They are not in `MCP_COLLECTION_SLUGS`,
 * so no key can reach them.
 */
export const MCP_OPERATIONS = ['find', 'create', 'update', 'delete'] as const

export type McpOperation = (typeof MCP_OPERATIONS)[number]

export type McpCapability = Partial<Record<McpOperation, boolean>>

export const MCP_COLLECTION_CAPABILITIES = {
  // Content
  pages: { create: true, delete: true, find: true, update: true },
  posts: { create: true, delete: true, find: true, update: true },
  media: { delete: true, find: true, update: true },
  categories: { create: true, delete: true, find: true, update: true },
  'payload-folders': { create: true, delete: true, find: true, update: true },

  // Navigation and moderation
  menus: { create: true, delete: true, find: true, update: true },
  comments: { delete: true, find: true, update: true },

  // Commerce
  products: { create: true, delete: true, find: true, update: true },
  store: { find: true, update: true },
  // Read-only: an order is created by checkout and moved by payment/fulfilment,
  // never by a model. `create`/`update` here would be a second sale path.
  orders: { find: true },

  // Design and identity
  theme: { find: true, update: true },
  'site-branding': { find: true, update: true },
  header: { find: true, update: true },
  footer: { find: true, update: true },

  // Custom content (the migration-era content model)
  'content-type-definitions': { create: true, find: true, update: true },
  'content-entries': { create: true, delete: true, find: true, update: true },
  'taxonomy-definitions': { create: true, find: true, update: true },
  'taxonomy-terms': { create: true, delete: true, find: true, update: true },
  'entry-term-relations': { create: true, delete: true, find: true },
  'content-relations': { create: true, delete: true, find: true },

  // Forms: definitions are editable; submissions are not an MCP resource and
  // deleting a form would take its evidence with it.
  forms: { create: true, find: true, update: true },

  // The tenant's own site record, read-only. Editing it (domain, status, plan
  // fields) is an operator decision, and field access already says so.
  sites: { find: true },
} as const satisfies Record<(typeof MCP_COLLECTION_SLUGS)[number], McpCapability>

/** There are no platform-wide globals available to MCP clients. */
export const MCP_GLOBAL_CAPABILITIES = {} as const

/**
 * Names of the custom tools registered in `src/mcp/tools`.
 *
 * Read-only on purpose. The plugin's generated key form gives every custom tool a
 * checkbox that defaults to *enabled*, so a write tool here would be granted to
 * every key the moment it was created. Publishing and deleting already work
 * through the collection tools, where the key's grant and `writeUnlessPublishing()`
 * decide; a second path through a custom tool would only weaken that.
 */
export const MCP_CUSTOM_TOOL_NAMES = [
  'cms_describe_capabilities',
  'cms_site_context',
  'cms_content_status',
] as const

/** Platform controls have a separate endpoint and accept only role: platform keys. */
export const MCP_PLATFORM_TOOL_NAMES = ['platform_read', 'platform_write'] as const

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
