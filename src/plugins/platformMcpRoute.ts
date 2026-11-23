import type { Plugin } from 'payload'

/**
 * Add a separately authenticated alias for platform tools. Both handlers are the
 * same Payload MCP instance; `mcpOverrideAuth` selects a disjoint tool catalogue
 * and key family from the request path before the MCP server is initialized.
 */
export const platformMcpRoute: Plugin = (config) => {
  const endpoints = config.endpoints ?? []
  const mcpRoutes = endpoints.filter(
    (endpoint) => endpoint.path === '/mcp' && ['get', 'post'].includes(endpoint.method),
  )

  if (!mcpRoutes.some((endpoint) => endpoint.method === 'post')) {
    throw new Error('Platform MCP route could not find the Payload MCP POST handler.')
  }
  if (endpoints.some((endpoint) => endpoint.path === '/platform/mcp')) {
    throw new Error('Platform MCP route already exists in Payload config.')
  }

  return {
    ...config,
    endpoints: [...endpoints, ...mcpRoutes.map((endpoint) => ({ ...endpoint, path: '/platform/mcp' }))],
  }
}
