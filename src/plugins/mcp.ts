import { mcpPlugin } from '@payloadcms/plugin-mcp'
import type { CollectionConfig } from 'payload'

import { platformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { MCP_COLLECTION_SLUGS, MCP_GLOBAL_SLUGS } from '@/plugins/mcp-slugs'

const allCollectionCrud = {
  find: true,
  create: true,
  update: true,
  delete: true,
} as const

const allGlobalAccess = {
  find: true,
  update: true,
} as const

export const mcpCollectionCapabilities = Object.fromEntries(
  MCP_COLLECTION_SLUGS.map((slug) => [slug, { enabled: allCollectionCrud }]),
)

export const mcpGlobalCapabilities = Object.fromEntries(
  MCP_GLOBAL_SLUGS.map((slug) => [slug, { enabled: allGlobalAccess }]),
)

/**
 * Payload MCP — Model Context Protocol over `/api/mcp`.
 *
 * Step 1 (here): every collection/global is eligible for find/create/update/delete.
 * Step 2 (admin): each `payload-mcp-api-keys` row toggles what that key may call.
 * Payload access control still applies — a site editor's key cannot read another tenant.
 *
 * Deliberately no Caddy carve-out on customer domains: same boundary as `/api/platform/*`.
 */
export const mcp = mcpPlugin({
  collections: mcpCollectionCapabilities,
  globals: mcpGlobalCapabilities,
  overrideApiKeyCollection: (collection: CollectionConfig) => {
    collection.admin = {
      ...collection.admin,
      group: PLATFORM_GROUPS.integrations,
      hidden: hiddenFromCustomers,
    }
    collection.labels = {
      plural: 'کلیدهای MCP',
      singular: 'کلید MCP',
    }
    collection.access = {
      // Operators issue automation keys; customers use site/api-keys instead.
      create: platformAdmin,
      delete: platformAdmin,
      read: platformAdmin,
      unlock: platformAdmin,
      update: platformAdmin,
    }
    for (const field of collection.fields) {
      if ('name' in field && field.name === 'user' && field.type === 'relationship') {
        field.access = {
          ...field.access,
          create: platformAdminFieldAccess,
          update: platformAdminFieldAccess,
        }
      }
    }
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
