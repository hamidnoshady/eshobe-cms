import type { PayloadRequest, Plugin } from 'payload'

import { idOf } from '@/lib/ids'
import { sanitizeChanges } from '@/platform/audit'

import { MCP_COLLECTION_CAPABILITIES, type McpCapability } from '@/mcp/capabilities'
import { readMcpKeyContext } from '@/mcp/context'

/**
 * An audit row for every content change an MCP key makes.
 *
 * ## Why a hook and not a wrapper around the tools
 *
 * The mutating tools are the plugin's generated `createPages` / `updatePosts` / ….
 * Wrapping them would mean re-registering the plugin's own tools, and the day the
 * plugin adds one the wrapper would not know about it. A collection hook sees every
 * write path — the generated tools today, a custom tool tomorrow — and it sees it
 * *after* validation, hooks and publish permission have run, so a refused write
 * leaves no audit row claiming it happened.
 *
 * ## Why `req.payloadAPI`
 *
 * The plugin sets `req.payloadAPI = 'MCP'` on the request it hands every tool, and a
 * tool passes that same request into Payload. The admin panel writes with
 * `payloadAPI: 'REST'`, seeds and jobs with `'local'`, so this hook is inert for all
 * of them: it records the automated caller and nobody else. The audit row's own
 * write reuses that request, but `audit-log` is not in the audited set, so there is
 * no recursion.
 *
 * ## What is written
 *
 * The key's label, the collection, the document id, the site, and `sanitizeChanges`
 * — field names plus short scalars, which already drops anything matching a secret
 * pattern. No request body, no header, no token. Same rule `recordAudit` states for
 * the control plane, applied to the one caller it does not cover.
 */

const AUDITED_EVENT = 'mcp.contentChanged' as const

/**
 * Collections whose writes are audited. Derived from the capability matrix rather
 * than typed twice, so enabling a write for a collection in `capabilities.ts`
 * audits it in the same change.
 */
const auditedSlugs = new Set(
  (Object.entries(MCP_COLLECTION_CAPABILITIES) as Array<[string, McpCapability]>)
    .filter(([, capability]) => capability.create === true || capability.update === true)
    .map(([slug]) => slug),
)

/** Exported for the spec that pins the matrix to the audited set. */
export const mcpAuditedCollectionSlugs = (): string[] => [...auditedSlugs].sort()

const actorFor = (label: null | string, id: number | string): string =>
  label ? `mcp:${label}`.slice(0, 120) : `mcp-key:${id}`

interface WriteAuditArgs {
  changes?: Record<string, unknown> | null
  req: PayloadRequest
  site?: unknown
  summary: string
  targetCollection: string
  targetId: null | string
}

/** Best-effort, always: an audit failure must never fail the write it describes. */
const writeAudit = async ({
  changes,
  req,
  site,
  summary,
  targetCollection,
  targetId,
}: WriteAuditArgs): Promise<void> => {
  const key = readMcpKeyContext(req)
  if (!key) return

  try {
    await req.payload.create({
      collection: 'audit-log',
      context: { disableRevalidate: true },
      data: {
        action: AUDITED_EVENT,
        actorEmail: actorFor(key.label, key.id),
        actorType: 'apiKey',
        changes: changes ?? null,
        site: idOf(site),
        summary: summary.slice(0, 500),
        targetCollection,
        targetId,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
  } catch (error) {
    req.payload.logger.error({ err: error as Error, msg: '[mcp] audit write failed' })
  }
}

/**
 * Registered after the MCP plugin so the key collection exists, and after the
 * multi-tenant plugin so `doc.site` is the tenant the write landed on. Only
 * write-capable collections are touched: a `find` leaves no row, and logging reads
 * would turn an audit trail into an access log nobody asked for.
 */
export const mcpAudit: Plugin = (config) => ({
  ...config,
  collections: config.collections?.map((collection) => {
    if (!auditedSlugs.has(collection.slug)) return collection

    const hooks = collection.hooks ?? {}
    return {
      ...collection,
      hooks: {
        ...hooks,
        afterChange: [
          ...(hooks.afterChange ?? []),
          async ({ doc, operation, previousDoc, req }) => {
            if (req.payloadAPI === 'MCP') {
              await writeAudit({
                changes: sanitizeChanges(
                  previousDoc as Record<string, unknown> | undefined,
                  doc as Record<string, unknown>,
                ),
                req,
                site: (doc as { site?: unknown }).site,
                summary: `${
                  operation === 'create' ? 'ایجاد' : 'ویرایش'
                } سند «${collection.slug}» از طریق MCP`,
                targetCollection: collection.slug,
                targetId: doc.id === undefined ? null : String(doc.id),
              })
            }
            return doc
          },
        ],
        afterDelete: [
          ...(hooks.afterDelete ?? []),
          async ({ doc, req }) => {
            if (req.payloadAPI === 'MCP') {
              await writeAudit({
                changes: null,
                req,
                site: (doc as { site?: unknown }).site,
                summary: `حذف سند «${collection.slug}» از طریق MCP`,
                targetCollection: collection.slug,
                targetId: doc.id === undefined ? null : String(doc.id),
              })
            }
            return doc
          },
        ],
      },
    }
  }),
})
