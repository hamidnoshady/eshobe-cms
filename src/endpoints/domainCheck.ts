import type { Endpoint } from 'payload'

import { isValidDomain, normalizeDomain, siteHostMatch } from '@/lib/domains'

/**
 * Caddy's on-demand TLS ask contract: it sends GET ?domain=example.com and
 * authorises issuance only when this endpoint returns HTTP 200. Every other
 * response (including 404) is a refusal and is intentionally cache-free.
 *
 * A tenant can own one primary hostname and several verified aliases such as
 * `www.example.com` or `shop.example.com`. All of them have to be authorised
 * here before Caddy asks the CA for a certificate; an unverified alias never
 * burns the CA rate limit merely because somebody pointed DNS at this server.
 */
export const domainCheck: Endpoint = {
  path: '/domain-check',
  method: 'get',
  handler: async (req) => {
    const domain = normalizeDomain(String(req.query.domain || ''))
    const controlHost = normalizeDomain(
      new URL(process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3000').hostname,
    )

    // Never authorise malformed hosts or the control plane itself.
    if (
      !domain ||
      domain === controlHost ||
      !isValidDomain(domain) ||
      domain.endsWith('.localhost')
    ) {
      return Response.json(
        { authorised: false },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      )
    }

    const { docs } = await req.payload.find({
      collection: 'sites',
      depth: 0,
      // `siteHostMatch` below validates the exact matching alias row, which guards
      // against a relational join matching this hostname on one row and `verified`
      // on another. The query only narrows candidates; it is not the authorisation.
      limit: 10,
      pagination: false,
      overrideAccess: true,
      where: {
        and: [
          { status: { equals: 'active' } },
          {
            or: [{ domain: { equals: domain } }, { 'domains.hostname': { equals: domain } }],
          },
        ],
      },
    })

    const authorised = docs.some((site) => {
      const match = siteHostMatch(site, domain)

      return Boolean(match && match.verified)
    })

    return authorised
      ? Response.json(
          { authorised: true },
          { status: 200, headers: { 'cache-control': 'no-store' } },
        )
      : Response.json(
          { authorised: false },
          { status: 404, headers: { 'cache-control': 'no-store' } },
        )
  },
}
