import type { Endpoint } from 'payload'

/**
 * Caddy's on-demand TLS ask contract: it sends GET ?domain=example.com and
 * authorises issuance only when this endpoint returns HTTP 200. Every other
 * response (including 404) is a refusal and is intentionally cache-free.
 */
export const domainCheck: Endpoint = {
  path: '/domain-check',
  method: 'get',
  handler: async (req) => {
    const domain = String(req.query.domain || '').trim().toLowerCase().replace(/\.$/, '')
    const controlHost = new URL(process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3000').hostname

    // Never authorise malformed hosts or the control plane itself.
    if (!domain || domain === controlHost || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
      return Response.json({ authorised: false }, { status: 404, headers: { 'cache-control': 'no-store' } })
    }

    const { docs } = await req.payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      pagination: false,
      overrideAccess: true,
      where: { and: [{ domain: { equals: domain } }, { status: { equals: 'active' } }, { domainVerified: { equals: true } }] },
    })

    return docs.length
      ? Response.json({ authorised: true }, { status: 200, headers: { 'cache-control': 'no-store' } })
      : Response.json({ authorised: false }, { status: 404, headers: { 'cache-control': 'no-store' } })
  },
}
