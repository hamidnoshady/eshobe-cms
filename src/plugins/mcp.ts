import { mcpPlugin } from '@payloadcms/plugin-mcp'
import type { CollectionConfig, CollectionSlug } from 'payload'

import { MCP_COLLECTION_SLUGS } from '@/plugins/mcp-slugs'

const noDelete = { delete: false } as const

/**
 * A capability is available only when the operation is safe for tenant content.
 * The plugin key is bound to its creating Payload user (the plugin's own default
 * access policy); the multi-tenant plugin then scopes each operation to that user.
 *
 * No delete operation is exposed. Rows containing credentials, billing data, user/site
 * administration, form submissions, deployments, webhooks and audit data are omitted
 * entirely rather than relying on every individual key to leave them unchecked.
 */
const SAFE_CAPABILITIES = {
  pages: { create: true, find: true, update: true, ...noDelete },
  posts: { create: true, find: true, update: true, ...noDelete },
  media: { find: true, update: true, ...noDelete },
  categories: { create: true, find: true, update: true, ...noDelete },
  'site-branding': { find: true, update: true, ...noDelete },
  header: { find: true, update: true, ...noDelete },
  footer: { find: true, update: true, ...noDelete },
  products: { create: true, find: true, update: true, ...noDelete },
  store: { find: true, update: true, ...noDelete },
  forms: { find: true, update: true, ...noDelete },
  'payload-folders': { create: true, find: true, update: true, ...noDelete },
} satisfies Partial<Record<CollectionSlug, { create?: boolean; delete?: boolean; find?: boolean; update?: boolean }>>

export const mcpCollectionCapabilities = Object.fromEntries(
  MCP_COLLECTION_SLUGS.map((slug) => [slug, { enabled: SAFE_CAPABILITIES[slug] }]),
) as Record<(typeof MCP_COLLECTION_SLUGS)[number], { enabled: (typeof SAFE_CAPABILITIES)[(typeof MCP_COLLECTION_SLUGS)[number]] }>

export const mcpGlobalCapabilities = {} as const

/**
 * Payload MCP — Model Context Protocol over `/api/mcp`.
 *
 * MCP API-key rows retain the plugin's safe default policy: authenticated users can
 * create their own key, only read/update/delete their own rows, and the `user` field
 * cannot be reassigned. The role attached to the key is therefore the real caller for
 * normal Payload access checks, including multi-tenant scoping. Never replace that with
 * platform-wide key management or `overrideAccess`.
 *
 * Deliberately no Caddy carve-out on customer domains. Credentials and capabilities
 * are enforced by this plugin plus collection access controls, not by a friendly UI.
 */
export const mcp = mcpPlugin({
  collections: mcpCollectionCapabilities,
  globals: mcpGlobalCapabilities,
  overrideApiKeyCollection: (collection: CollectionConfig) => {
    collection.admin = {
      ...collection.admin,
      group: 'یکپارچه‌سازی',
    }
    collection.labels = {
      plural: 'کلیدهای MCP',
      singular: 'کلید MCP',
    }

    // Keep the plugin's per-user access rules and locked owner field intact.
    return collection
  },
  mcp: {
    serverOptions: {
      serverInfo: {
        name: 'Eshobe CMS MCP',
        version: '1.0.0',
      },
    },
  },
})
