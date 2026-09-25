import type { PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { isUuid } from '@/lib/ids'

/**
 * The preamble every `/api/platform/*` endpoint file shares.
 *
 * `platformControl`, `platformSaas` and `platformDeployments` each grew their own
 * byte-identical copies of these — the operator guard, the site lookup, and the
 * no-store JSON responder — which is exactly the drift risk this module removes:
 * a security guard duplicated four times is four places for one of them to fall
 * out of step. There is one `requireOperator` now, so "who may call the platform
 * API" has a single definition. (The collection-scoped endpoints on `ApiKeys` and
 * `DeployTargets` keep their own boolean-returning `requireOperator`: a different
 * contract for a different dispatch path, deliberately not merged here.)
 */

/** Platform responses are per-request state, never cached by an intermediary. */
export const noStore = { 'cache-control': 'no-store' }

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: noStore, status })

/**
 * The `/api/platform/*` boundary: a platform-admin session or a `role: "platform"`
 * API key, and nothing a site key satisfies. Returns `null` to proceed, or the 403
 * response to return as-is — so a handler reads `if (denied) return denied`.
 */
export const requireOperator = async (req: PayloadRequest): Promise<null | Response> => {
  if (await isPlatformAdminOrPlatformKey(req, isPlatformAdmin(req.user))) return null
  return json({ message: 'این بخش فقط برای مدیر پلتفرم است.', ok: false }, 403)
}

/** A route param as a string, empty when absent. */
export const param = (req: PayloadRequest, name: string): string =>
  String((req.routeParams as Record<string, unknown> | undefined)?.[name] ?? '')

/** The request's query string, empty (never throwing) when the URL cannot be parsed. */
export const search = (req: PayloadRequest): URLSearchParams => {
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** The one site lookup every `/platform/sites/:id` route shares — shape-checked before the query (`src/lib/ids.ts`). */
export const siteById = async (
  req: PayloadRequest,
  id: string,
): Promise<null | Record<string, unknown>> => {
  if (!isUuid(id)) return null
  const doc = await req.payload.findByID({
    id,
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })
  return (doc as unknown as null | Record<string, unknown>) ?? null
}
