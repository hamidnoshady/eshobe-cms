import type { PayloadRequest } from 'payload'

import { toCamelCase } from './capabilities'

/**
 * What `overrideAuth` hands the rest of the request.
 *
 * Custom tool handlers receive a `PayloadRequest` and nothing else — the MCP plugin
 * passes the key's *user* to the generated collection tools, but a custom tool only
 * sees `req`. Putting the key on `req.context` is what lets a read-only discovery
 * tool answer "what may **this** key do" instead of advertising the whole deployment
 * surface to a key that was minted for one collection.
 *
 * It lives on the request, is never serialized, and never reaches a response.
 */
export const MCP_KEY_CONTEXT = 'mcpApiKey'
export const MCP_PLATFORM_KEY_CONTEXT = 'mcpPlatformApiKey'

export interface McpKeyContext {
  /** The `payload-mcp-api-keys` row id. Stable, and what rate limits bucket on. */
  id: number | string
  /** The operator's label. This is the actor an audit row names. */
  label: null | string
  /** The capability groups from the key row, exactly as the plugin reads them. */
  capabilities: Record<string, unknown>
}

export interface McpPlatformKeyContext {
  id: string
}

export const readMcpKeyContext = (req: PayloadRequest): McpKeyContext | null => {
  const raw = (req.context as Record<string, unknown> | undefined)?.[MCP_KEY_CONTEXT]
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<McpKeyContext>
  if (value.id === undefined) return null
  return {
    capabilities: value.capabilities ?? {},
    id: value.id,
    label: value.label ?? null,
  }
}

export const readMcpPlatformKeyContext = (req: PayloadRequest): McpPlatformKeyContext | null => {
  const raw = (req.context as Record<string, unknown> | undefined)?.[MCP_PLATFORM_KEY_CONTEXT]
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<McpPlatformKeyContext>
  return typeof value.id === 'string' && value.id ? { id: value.id } : null
}

/** The operations this key was actually granted for one collection, in the plugin's key shape. */
export const grantedOperationsFor = (
  context: McpKeyContext | null,
  collection: string,
): Record<string, boolean> => {
  if (!context) return {}
  const group = context.capabilities[toCamelCase(collection)]
  if (!group || typeof group !== 'object') return {}
  return Object.fromEntries(
    Object.entries(group as Record<string, unknown>).filter(([, value]) => value === true),
  ) as Record<string, boolean>
}

/** The custom tools enabled on this key, or null when there is no key on the request. */
export const grantedCustomTools = (context: McpKeyContext | null): null | string[] => {
  if (!context) return null
  const group = context.capabilities['payload-mcp-tool']
  if (!group || typeof group !== 'object') return []
  return Object.entries(group as Record<string, unknown>)
    .filter(([, value]) => value === true)
    .map(([name]) => name)
}
