import { handleTorobProductRequest } from '@/lib/torob/product-api'

/**
 * Torob Product API v3 on the customer's own origin (issue #183).
 *
 * Deliberately outside `(site)/[domain]`: it is a machine API, not a localized page.
 * `src/proxy.ts` leaves this exact path alone, and Caddy carves it out to web:3000
 * before any deployed theme upstream. The handler resolves the tenant from `Host`
 * and verifies the JWT audience against the stored canonical domain.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleTorobProductRequest(request)
}

const methodNotAllowed = (): Response =>
  Response.json({ error: 'method_not_allowed' }, { headers: { allow: 'POST', 'cache-control': 'no-store' }, status: 405 })

export const GET = methodNotAllowed
export const HEAD = methodNotAllowed
export const PUT = methodNotAllowed
export const PATCH = methodNotAllowed
export const DELETE = methodNotAllowed
export const OPTIONS = methodNotAllowed
