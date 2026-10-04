import { describe, expect, it } from 'vitest'

import { mcpCollectionCapabilities, mcpGlobalCapabilities } from '@/plugins/mcp'
import { MCP_COLLECTION_SLUGS, MCP_GLOBAL_SLUGS } from '@/plugins/mcp-slugs'

describe('Payload MCP capability boundary', () => {
  it('only exposes the explicit tenant content allowlist', () => {
    expect(Object.keys(mcpCollectionCapabilities).sort()).toEqual([...MCP_COLLECTION_SLUGS].sort())
    expect(MCP_GLOBAL_SLUGS).toEqual([])
    expect(mcpGlobalCapabilities).toEqual({})

    for (const forbidden of [
      'users',
      'sites',
      'api-keys',
      'storage-connections',
      'payment-gateways',
      'billing-service-credentials',
      'billing-storage-accounts',
      'site-theme-settings',
      'site-deployments',
      'theme-bindings',
      'webhooks',
      'webhook-deliveries',
      'audit-log',
      'form-submissions',
      'orders',
    ]) {
      expect(mcpCollectionCapabilities).not.toHaveProperty(forbidden)
    }
  })

  it('permits only the declared operations and never delete', () => {
    const expected = {
      categories: ['create', 'find', 'update'],
      footer: ['find', 'update'],
      forms: ['find', 'update'],
      header: ['find', 'update'],
      media: ['find', 'update'],
      pages: ['create', 'find', 'update'],
      'payload-folders': ['create', 'find', 'update'],
      posts: ['create', 'find', 'update'],
      products: ['create', 'find', 'update'],
      'site-branding': ['find', 'update'],
      store: ['find', 'update'],
    }

    for (const [slug, operations] of Object.entries(expected)) {
      const enabled = mcpCollectionCapabilities[slug as keyof typeof mcpCollectionCapabilities]?.enabled
      expect(Object.entries(enabled ?? {}).filter(([, allowed]) => allowed).map(([op]) => op).sort()).toEqual(
        [...operations].sort(),
      )
      expect(enabled).not.toHaveProperty('delete', true)
    }
  })
})
