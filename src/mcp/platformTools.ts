import type { Endpoint, PayloadRequest } from 'payload'
import { z } from 'zod'

import { readMcpPlatformKeyContext } from './context'
import {
  platformEventsEndpoint,
  platformOverviewEndpoint,
  platformSiteEndpoint,
  platformSitePatchEndpoint,
  platformSitesEndpoint,
  platformSnapshotExportEndpoint,
  platformSnapshotImportEndpoint,
} from '@/endpoints/platformControl'
import {
  routingTableEndpoint,
  siteDeploymentCreateEndpoint,
  siteDeploymentGetEndpoint,
  siteDeploymentPollEndpoint,
  siteDeploymentReadinessEndpoint,
  siteDeploymentRedeployEndpoint,
  siteDeploymentRevertEndpoint,
  siteDeploymentRollbackEndpoint,
  siteDeploymentStopEndpoint,
  siteDeploymentVerifyEndpoint,
  themePackageSyncEndpoint,
  themePackagesListEndpoint,
} from '@/endpoints/platformDeployments'
import {
  applyThemeEndpoint,
  auditListEndpoint,
  featuresListEndpoint,
  plansListEndpoint,
  pluginPatchEndpoint,
  pluginsListEndpoint,
  saasOverviewEndpoint,
  settingsGetEndpoint,
  siteEntitlementEndpoint,
  siteFeatureEndpoint,
  siteQuotaEndpoint,
  siteUsageEndpoint,
  subscriptionsListEndpoint,
  themesListEndpoint,
} from '@/endpoints/platformSaas'

/**
 * Deliberately curated wrappers around the platform API handlers. The handlers
 * remain the source of validation, operator authorization, and business rules.
 * No generic URL, collection, or endpoint is accepted from an MCP caller.
 */
const READS = {
  'audit.list': auditListEndpoint,
  'deployment.get': siteDeploymentGetEndpoint,
  'deployment.readiness': siteDeploymentReadinessEndpoint,
  'events.list': platformEventsEndpoint,
  'features.list': featuresListEndpoint,
  'overview.get': platformOverviewEndpoint,
  'plans.list': plansListEndpoint,
  'plugins.list': pluginsListEndpoint,
  'routing.list': routingTableEndpoint,
  'saas.overview': saasOverviewEndpoint,
  'settings.get': settingsGetEndpoint,
  'site.entitlement': siteEntitlementEndpoint,
  'site.get': platformSiteEndpoint,
  'site.list': platformSitesEndpoint,
  'site.quota': siteQuotaEndpoint,
  'site.snapshot.export': platformSnapshotExportEndpoint,
  'site.usage': siteUsageEndpoint,
  'subscriptions.list': subscriptionsListEndpoint,
  'theme-packages.list': themePackagesListEndpoint,
  'themes.list': themesListEndpoint,
} as const

const WRITES = {
  'deployment.create': siteDeploymentCreateEndpoint,
  'deployment.poll': siteDeploymentPollEndpoint,
  'deployment.redeploy': siteDeploymentRedeployEndpoint,
  'deployment.revert': siteDeploymentRevertEndpoint,
  'deployment.rollback': siteDeploymentRollbackEndpoint,
  'deployment.stop': siteDeploymentStopEndpoint,
  'deployment.verify': siteDeploymentVerifyEndpoint,
  'plugin.update': pluginPatchEndpoint,
  'site.feature.update': siteFeatureEndpoint,
  'site.snapshot.import': platformSnapshotImportEndpoint,
  'site.update': platformSitePatchEndpoint,
  'theme.apply': applyThemeEndpoint,
  'theme-package.sync': themePackageSyncEndpoint,
} as const

type OperationMap = typeof READS | typeof WRITES
type OperationName<T extends OperationMap> = keyof T & string

const enumOf = <T extends Record<string, unknown>>(value: T) =>
  z.enum(Object.keys(value) as [keyof T & string, ...(keyof T & string)[]])

const scalar = z.union([z.string(), z.number(), z.boolean()])
const requestSchema = <T extends Record<string, unknown>>(operations: T) =>
  z
    .object({
      body: z.record(z.string(), z.unknown()).optional(),
      operation: enumOf(operations),
      pathParams: z.record(z.string(), z.string().min(1)).optional(),
      query: z.record(z.string(), scalar).optional(),
    })
    .strict()

const readSchema = requestSchema(READS)
const writeSchema = requestSchema(WRITES)

const routedRequest = (
  req: PayloadRequest,
  endpoint: Endpoint,
  pathParams: Record<string, string>,
  query: Record<string, string | number | boolean>,
  body?: Record<string, unknown>,
): PayloadRequest => {
  if (!endpoint.handler || !endpoint.path || !endpoint.method) {
    throw new Error('Platform MCP operation is not a callable endpoint.')
  }

  const expectedParams = [...endpoint.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]!)
  if (
    expectedParams.some((name) => !pathParams[name]) ||
    Object.keys(pathParams).some((name) => !expectedParams.includes(name))
  ) {
    throw new Error(`Expected path parameters: ${expectedParams.join(', ') || '(none)'}.`)
  }

  const path = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) =>
    encodeURIComponent(pathParams[name]!),
  )
  const url = new URL(`/api${path}`, req.url || 'http://localhost')
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value))

  const method = endpoint.method.toUpperCase()
  const headers = new Headers(req.headers)
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const routed = new Request(url, {
    headers,
    method,
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body ?? {}) }),
  })

  // These handlers already enforce the platform-key boundary themselves. Retain
  // the Payload instance, request context, and key-bearing Authorization header.
  return Object.assign(routed, {
    context: req.context,
    locale: req.locale,
    payload: req.payload,
    payloadAPI: 'MCP',
    routeParams: pathParams,
    user: req.user,
  }) as PayloadRequest
}

const runEndpoint = async (
  operation: string,
  endpoint: Endpoint,
  args: Record<string, unknown>,
  req: PayloadRequest,
) => {
  if (!readMcpPlatformKeyContext(req)) {
    return { content: [{ type: 'text' as const, text: 'Platform MCP access is required.' }], isError: true }
  }

  try {
    const routed = routedRequest(
      req,
      endpoint,
      (args.pathParams ?? {}) as Record<string, string>,
      (args.query ?? {}) as Record<string, string | number | boolean>,
      args.body as Record<string, unknown> | undefined,
    )
    const response = await endpoint.handler!(routed)
    if (!(response instanceof Response)) {
      return {
        content: [{ type: 'text' as const, text: `Platform operation ${operation} returned no response.` }],
        isError: true,
      }
    }
    const text = await response.text()
    let businessFailure = false
    try {
      businessFailure = (JSON.parse(text) as { ok?: unknown }).ok === false
    } catch {
      // Preserve a non-JSON response as text; the HTTP status remains authoritative.
    }
    return {
      content: [{ type: 'text' as const, text }],
      ...(!response.ok || businessFailure ? { isError: true } : {}),
    }
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: `[mcp] platform operation ${operation} failed` })
    return {
      content: [{ type: 'text' as const, text: `Platform operation ${operation} failed.` }],
      isError: true,
    }
  }
}

const readOperationNames = Object.keys(READS).join(', ')
const writeOperationNames = Object.keys(WRITES).join(', ')

export const mcpPlatformTools = [
  {
    name: 'platform_read',
    description:
      `Read platform-wide reports, site records, audit, settings, entitlements, and deployments. Allowed operations: ${readOperationNames}. Use pathParams.id for site or deployment routes and query for URL filters.`,
    parameters: readSchema.shape,
    handler: async (args: Record<string, unknown>, req: PayloadRequest) => {
      const parsed = readSchema.safeParse(args)
      if (!parsed.success) {
        return { content: [{ type: 'text' as const, text: 'Invalid platform read arguments.' }], isError: true }
      }
      const endpoint = READS[parsed.data.operation as OperationName<typeof READS>]
      return runEndpoint(parsed.data.operation, endpoint, parsed.data, req)
    },
  },
  {
    name: 'platform_write',
    description:
      `Write through the CMS operator routes: update site lifecycle fields, import snapshots, change plugin/theme/feature settings, sync themes, and operate deployments. Allowed operations: ${writeOperationNames}. Supply pathParams.id where required and a JSON body. For snapshot import, first use dryRun:true and only perform the import after reviewing the plan. Session-only operations (including publishing a theme package and editing platform settings) are intentionally unavailable to API keys.`,
    parameters: writeSchema.shape,
    handler: async (args: Record<string, unknown>, req: PayloadRequest) => {
      const parsed = writeSchema.safeParse(args)
      if (!parsed.success) {
        return { content: [{ type: 'text' as const, text: 'Invalid platform write arguments.' }], isError: true }
      }
      const endpoint = WRITES[parsed.data.operation as OperationName<typeof WRITES>]
      return runEndpoint(parsed.data.operation, endpoint, parsed.data, req)
    },
  },
]
