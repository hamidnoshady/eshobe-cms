import type { MCPAccessSettings, MCPPluginConfig } from '@payloadcms/plugin-mcp'
import { APIError, type PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { requestApiKey } from '@/access/siteApiKey'
import { MCP_COLLECTION_SLUGS } from '@/plugins/mcp-slugs'

import { MCP_PLATFORM_TOOL_NAMES, toCamelCase } from './capabilities'
import {
  MCP_KEY_CONTEXT,
  MCP_PLATFORM_KEY_CONTEXT,
  type McpKeyContext,
} from './context'
import { assertBodyWithinLimit, consumeMcpRateLimit } from './limits'

/**
 * The MCP request gate: body size, credential lifetime, rate, and attribution.
 *
 * It replaces nothing. The plugin's own resolver still finds the key row, still
 * refuses a missing or unknown bearer value, and still returns the settings the
 * generated tools read. This wrapper runs *around* that resolver because the
 * checks below need the key row's identity, which only exists after it resolves.
 *
 * Three deliberate properties:
 *
 *  - **Expiry is enforced here, not in the admin UI.** A field that greys a row out
 *    is advice; a 401 on the next request is the control. A key with no
 *    `expiresAt` never expires, which keeps every key minted before this check
 *    working exactly as it did.
 *  - **Refusals are coarse.** "Unauthorized", "Too many requests", "Request body too
 *    large" — never "key 17 expired at 14:02" and never the key's owner. Every one of
 *    those sentences would let a stranger probe this deployment's key inventory.
 *  - **The key is put on the request, once.** Custom tools have no other way to know
 *    which credential is acting, and an audit row that names the key rather than the
 *    person behind it is the correct attribution for an automated caller.
 */

type KeyDoc = MCPAccessSettings & {
  expiresAt?: null | string
  id: number | string
  label?: null | string
}

const asKeyDoc = (settings: MCPAccessSettings): KeyDoc => settings as unknown as KeyDoc

const assertNotExpired = (key: KeyDoc): void => {
  if (!key.expiresAt) return
  const expiry = Date.parse(key.expiresAt)
  // An unparseable date is treated as expired: a lifetime nobody can evaluate is not
  // a lifetime, and the safe answer for a credential is "no".
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new APIError('Unauthorized', 401)
  }
}

/**
 * The capability groups this app knows about, copied off the key row.
 *
 * An allowlist, not a copy of the document. The key row also carries the owner, the
 * hashed key index and the plugin's own bookkeeping; putting the whole thing on
 * `req.context` would make a future tool that logs its request a credential leak.
 */
const capabilitiesOf = (key: KeyDoc): Record<string, unknown> => {
  const record = key as unknown as Record<string, unknown>
  const capabilities: Record<string, unknown> = {}
  for (const slug of MCP_COLLECTION_SLUGS) {
    capabilities[toCamelCase(slug)] = record[toCamelCase(slug)] ?? {}
  }
  capabilities['payload-mcp-tool'] = record['payload-mcp-tool'] ?? {}
  return capabilities
}

const isPlatformMcpPath = (req: PayloadRequest): boolean => {
  try {
    return new URL(req.url ?? '', 'http://localhost').pathname === '/api/platform/mcp'
  } catch {
    return false
  }
}

const platformMcpSettings = (): MCPAccessSettings => ({
  // The platform endpoint exposes custom handlers only. In particular it never
  // grants generated CRUD tools, which would otherwise run as a platform admin and
  // bypass the tenant plugin's site constraint.
  user: null as unknown as MCPAccessSettings['user'],
  'payload-mcp-tool': Object.fromEntries(
    MCP_PLATFORM_TOOL_NAMES.map((name) => [toCamelCase(name), true]),
  ),
})

export const mcpOverrideAuth: NonNullable<MCPPluginConfig['overrideAuth']> = async (
  req: PayloadRequest,
  getDefaultMcpAccessSettings,
) => {
  assertBodyWithinLimit(req.headers?.get?.('content-length') ?? null)

  if (isPlatformMcpPath(req)) {
    const key = await requestApiKey(req)
    if (key?.role !== 'platform') throw new APIError('Unauthorized', 401)

    const decision = consumeMcpRateLimit(`platform:${key.id}`)
    if (!decision.allowed) throw new APIError('Too many requests', 429)

    req.context = {
      ...(req.context ?? {}),
      [MCP_PLATFORM_KEY_CONTEXT]: { id: key.id },
    }
    return platformMcpSettings()
  }

  const settings = await getDefaultMcpAccessSettings()
  const key = asKeyDoc(settings)

  // A platform-admin user bypasses the multi-tenant plugin's site constraints.
  // Never let that identity use tenant CRUD tools. Platform work has its own
  // endpoint and API-key family, with an explicitly curated custom-tool surface.
  if (isPlatformAdmin(settings.user)) throw new APIError('Forbidden', 403)

  assertNotExpired(key)

  const decision = consumeMcpRateLimit(key.id)
  if (!decision.allowed) {
    throw new APIError('Too many requests', 429)
  }

  const capabilities = capabilitiesOf(key)
  const customTools = capabilities['payload-mcp-tool']
  if (customTools && typeof customTools === 'object') {
    for (const name of MCP_PLATFORM_TOOL_NAMES) {
      delete (customTools as Record<string, unknown>)[toCamelCase(name)]
    }
  }

  const context: McpKeyContext = {
    capabilities,
    id: key.id,
    label: key.label ?? null,
  }

  req.context = { ...(req.context ?? {}), [MCP_KEY_CONTEXT]: context }

  return {
    ...settings,
    'payload-mcp-tool': customTools as Record<string, boolean> | undefined,
  }
}
