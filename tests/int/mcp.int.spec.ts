import { describe, expect, it } from 'vitest'

import { mcpCollectionCapabilities, mcpGlobalCapabilities } from '@/plugins/mcp'
import { MCP_COLLECTION_SLUGS, MCP_GLOBAL_SLUGS } from '@/plugins/mcp-slugs'

describe('Payload MCP plugin', () => {
  it('enables full CRUD on every CMS collection slug', () => {
    for (const slug of MCP_COLLECTION_SLUGS) {
      expect(mcpCollectionCapabilities[slug]?.enabled).toEqual({
        find: true,
        create: true,
        update: true,
        delete: true,
      })
    }
  })

  it('enables find and update on platform globals', () => {
    for (const slug of MCP_GLOBAL_SLUGS) {
      expect(mcpGlobalCapabilities[slug]?.enabled).toEqual({
        find: true,
        update: true,
      })
    }
  })
})
