import { describe, expect, it } from 'vitest'

import { mcpCollectionCapabilities, mcpGlobalCapabilities } from '@/plugins/mcp'
import { MCP_COLLECTION_SLUGS, MCP_GLOBAL_SLUGS } from '@/plugins/mcp-slugs'

/**
 * The MCP surface is the tenant's own site, and nothing that administers the
 * platform. This file pins both halves of that sentence:
 *
 *  - every collection a site's editor owns is present, with the operations the
 *    matrix declares (delete is opt-in per key, but the capability has to exist
 *    for the per-key checkbox to appear);
 *  - the rows that would hand an assistant platform authority or credentials are
 *    absent, so no key can reach them by toggling anything.
 */
describe('Payload MCP capability boundary', () => {
  it('exposes exactly the declared tenant collections and no globals', () => {
    expect(Object.keys(mcpCollectionCapabilities).sort()).toEqual([...MCP_COLLECTION_SLUGS].sort())
    expect(MCP_GLOBAL_SLUGS).toEqual([])
    expect(mcpGlobalCapabilities).toEqual({})

    for (const forbidden of [
      // Staff accounts and roles: an assistant must not be able to mint an owner.
      'users',
      // Platform credentials and billing.
      'api-keys',
      'storage-connections',
      'payment-gateways',
      'billing-service-credentials',
      'billing-storage-accounts',
      // Secret-bearing tenant configuration (theme settings answers).
      'site-theme-settings',
      // Deployment machinery.
      'site-deployments',
      'theme-bindings',
      'theme-packages',
      'deploy-targets',
      // Delivery and audit.
      'webhooks',
      'webhook-deliveries',
      'audit-log',
      // Buyer PII that belongs to the checkout flow, not to a model's reach.
      'form-submissions',
    ]) {
      expect(mcpCollectionCapabilities).not.toHaveProperty(forbidden)
    }
  })

  it('declares the operations each collection actually supports', () => {
    const expected: Record<string, string[]> = {
      categories: ['create', 'delete', 'find', 'update'],
      comments: ['delete', 'find', 'update'],
      'content-entries': ['create', 'delete', 'find', 'update'],
      'content-relations': ['create', 'delete', 'find'],
      'content-type-definitions': ['create', 'find', 'update'],
      'entry-term-relations': ['create', 'delete', 'find'],
      footer: ['find', 'update'],
      forms: ['create', 'find', 'update'],
      header: ['find', 'update'],
      media: ['delete', 'find', 'update'],
      menus: ['create', 'delete', 'find', 'update'],
      orders: ['find'],
      pages: ['create', 'delete', 'find', 'update'],
      'payload-folders': ['create', 'delete', 'find', 'update'],
      posts: ['create', 'delete', 'find', 'update'],
      products: ['create', 'delete', 'find', 'update'],
      'site-branding': ['find', 'update'],
      sites: ['find'],
      store: ['find', 'update'],
      'taxonomy-definitions': ['create', 'find', 'update'],
      'taxonomy-terms': ['create', 'delete', 'find', 'update'],
      theme: ['find', 'update'],
    }

    expect(Object.keys(expected).sort()).toEqual([...MCP_COLLECTION_SLUGS].sort())

    for (const [slug, operations] of Object.entries(expected)) {
      const enabled = mcpCollectionCapabilities[slug as keyof typeof mcpCollectionCapabilities]?.enabled
      expect(
        Object.entries(enabled ?? {})
          .filter(([, allowed]) => allowed)
          .map(([op]) => op)
          .sort(),
        slug,
      ).toEqual([...operations].sort())
    }
  })

  it('never offers delete where losing the row would not be losing content', () => {
    // A sale, the site's own identity, the singletons that make the site render,
    // form definitions whose submissions outlive them, and the two definition
    // collections whose deletion cascades through entries and terms.
    for (const slug of [
      'orders',
      'sites',
      'theme',
      'site-branding',
      'header',
      'footer',
      'store',
      'forms',
      'content-type-definitions',
      'taxonomy-definitions',
    ]) {
      const enabled = mcpCollectionCapabilities[slug as keyof typeof mcpCollectionCapabilities]?.enabled
      expect(enabled, slug).not.toHaveProperty('delete', true)
    }
  })
})
