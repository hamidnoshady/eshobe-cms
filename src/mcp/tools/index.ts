import type { PayloadRequest } from 'payload'
import { z } from 'zod'

import {
  describeMcpSurface,
  MCP_COLLECTION_CAPABILITIES,
  toCamelCase,
  type McpOperation,
} from '../capabilities'
import { grantedCustomTools, grantedOperationsFor, readMcpKeyContext } from '../context'
import { errorResult, okResult, safeErrorDetail } from '../result'

/**
 * Custom MCP tools.
 *
 * Everything here is **read-only**. See `MCP_CUSTOM_TOOL_NAMES` for why: the
 * plugin's key form gives a custom tool a checkbox defaulting to enabled, so a
 * mutating custom tool would arrive already granted on every key that exists.
 *
 * Each handler takes its authority from `req`, never from its arguments:
 * `readMcpKeyContext` is the key `overrideAuth` resolved, and every Payload read
 * runs with `overrideAccess: false` so the multi-tenant plugin's site scope is
 * applied exactly as it is for a session. No handler accepts a `site` argument —
 * a tool argument that selects a tenant is the leak, not the safety valve.
 */

type ToolArgs = Record<string, unknown>

interface ToolDefinition {
  description: string
  handler: (args: ToolArgs, req: PayloadRequest) => Promise<{
    content: Array<{ text: string; type: 'text' }>
  }>
  name: string
  parameters: z.ZodRawShape
}

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/** The tool names the plugin registers for one collection, e.g. `findPages`. */
const collectionToolNames = (collection: string, operations: readonly McpOperation[]): string[] => {
  const suffix = capitalize(toCamelCase(collection))
  return operations.map((operation) => `${operation}${suffix}`)
}

const capabilityOnly = (values: Record<string, unknown>): Record<string, true> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value === true)) as Record<
    string,
    true
  >

const describeCapabilities: ToolDefinition = {
  description:
    'Describe what this CMS exposes over MCP: the collections, the operations enabled on them, the exact tool names to call, the enabled languages and the tools granted to the current key. Call this before guessing a tool name or a field.',
  handler: async (_args, req) => {
    try {
      const surface = describeMcpSurface()
      const key = readMcpKeyContext(req)
      const localization = req.payload.config.localization || null

      const collections = surface.collections.map(({ collection, operations }) => {
        const granted = key ? capabilityOnly(grantedOperationsFor(key, collection)) : {}
        // Without a key context the request would already have been refused, so
        // falling back to the granted set is the only truthful answer.
        const effective = (key ? Object.keys(granted) : operations) as McpOperation[]
        return {
          collection,
          configuredOperations: operations,
          grantedOperations: Object.keys(granted),
          toolNames: collectionToolNames(collection, effective),
        }
      })

      return okResult({
        collections,
        globals: surface.globals,
        languages: {
          defaultLocale: localization?.defaultLocale ?? null,
          locales:
            localization?.locales.map((locale) =>
              typeof locale === 'string' ? locale : locale.code,
            ) ?? [],
        },
        notes: [
          'No delete tool is registered. Removing content is an editor decision, not an assistant one.',
          'Updates go through the same validation, hooks, quota checks and publish permission as the admin panel. A refused write is a business rule, not a bug.',
          'Every query is scoped to the site the key belongs to. There is no parameter that selects another site.',
        ],
        tools: key ? (grantedCustomTools(key) ?? []) : surface.tools,
        version: 1,
      })
    } catch (error) {
      req.payload.logger.error({ err: error as Error, msg: '[mcp] cms_describe_capabilities failed' })
      return errorResult('tool_failed', `Could not describe this CMS: ${safeErrorDetail(error)}`)
    }
  },
  name: 'cms_describe_capabilities',
  parameters: {},
}

const siteContext: ToolDefinition = {
  description:
    'Read the site this MCP key belongs to: name, primary domain, site type, lifecycle status and the languages it serves. Use it to confirm which site you are editing before writing content.',
  handler: async (_args, req) => {
    try {
      const { docs } = await req.payload.find({
        collection: 'sites',
        depth: 0,
        limit: 10,
        overrideAccess: false,
        req,
        // Only the facts a content assistant needs. The document holds billing links,
        // deployment state and operator notes that are none of a content key's
        // business, and `select` is what keeps them off the wire.
        select: {
          availableLocales: true,
          defaultLocale: true,
          domain: true,
          domainVerified: true,
          name: true,
          status: true,
          type: true,
        },
      })

      return okResult({
        sites: docs.map((doc) => ({
          availableLocales: doc.availableLocales ?? null,
          defaultLocale: doc.defaultLocale ?? null,
          domain: doc.domain ?? null,
          domainVerified: doc.domainVerified ?? null,
          id: doc.id,
          name: doc.name,
          status: doc.status,
          type: doc.type,
        })),
      })
    } catch (error) {
      req.payload.logger.error({ err: error as Error, msg: '[mcp] cms_site_context failed' })
      return errorResult('not_permitted', 'This key may not read site information.')
    }
  },
  name: 'cms_site_context',
  parameters: {},
}

const CONTENT_COLLECTIONS = ['pages', 'posts'] as const

const contentStatusSchema = z.object({
  collection: z.enum(CONTENT_COLLECTIONS),
  limit: z.number().int().min(1).max(50).optional(),
  status: z.enum(['all', 'draft', 'published']).optional(),
})

const contentStatus: ToolDefinition = {
  description:
    'List the publishing state of a content collection: title, slug, draft or published, publication date and whether a publication is scheduled for the future. Use it to answer "what is live", "what is still a draft" and "what goes out later" without reading every document.',
  handler: async (args, req) => {
    const parsed = contentStatusSchema.safeParse(args)
    if (!parsed.success) {
      return errorResult(
        'invalid_input',
        `Expected { collection: "pages" | "posts", limit?: 1-50, status?: "all" | "draft" | "published" }.`,
      )
    }

    const { collection, limit = 20, status = 'all' } = parsed.data
    const configured = MCP_COLLECTION_CAPABILITIES[collection]
    if (!configured.find) {
      return errorResult(
        'unsupported_collection',
        `"${collection}" is not available over MCP on this deployment.`,
      )
    }

    try {
      const { docs, totalDocs } = await req.payload.find({
        collection,
        depth: 0,
        draft: true,
        limit,
        overrideAccess: false,
        req,
        select: {
          _status: true,
          publishedAt: true,
          slug: true,
          title: true,
          updatedAt: true,
        },
        sort: '-updatedAt',
        ...(status === 'all' ? {} : { where: { _status: { equals: status } } }),
      })

      const now = Date.now()
      return okResult({
        collection,
        documents: docs.map((doc) => {
          const publishedAt = typeof doc.publishedAt === 'string' ? doc.publishedAt : null
          const timestamp = publishedAt ? Date.parse(publishedAt) : Number.NaN
          return {
            id: doc.id,
            publishedAt,
            scheduledForFuture: Number.isFinite(timestamp) && timestamp > now,
            slug: doc.slug ?? null,
            status: doc._status === 'published' ? 'published' : 'draft',
            title: doc.title ?? null,
            updatedAt: doc.updatedAt ?? null,
          }
        }),
        totalDocs,
      })
    } catch (error) {
      req.payload.logger.error({ err: error as Error, msg: '[mcp] cms_content_status failed' })
      return errorResult('not_permitted', `This key may not read "${collection}".`)
    }
  },
  name: 'cms_content_status',
  parameters: contentStatusSchema.shape,
}

export const mcpTools: ToolDefinition[] = [describeCapabilities, siteContext, contentStatus]
