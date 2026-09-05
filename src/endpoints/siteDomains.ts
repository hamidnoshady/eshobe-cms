import type { Endpoint } from 'payload'

import type { Site } from '@/payload-types'

import { domainValidationMessage, isValidDomain, normalizeDomain } from '@/lib/domains'

import { hostnameIsTaken, siteForDomainKey } from './updateSiteDomain'

const noStore = { 'cache-control': 'no-store' }

type DomainAlias = NonNullable<Site['domains']>[number]

const aliasesFor = (site: Pick<Site, 'domains'>): DomainAlias[] =>
  Array.isArray(site.domains) ? site.domains : []

const aliasesResponse = (site: Pick<Site, 'domain' | 'domainVerified' | 'domains'>) => ({
  aliases: aliasesFor(site).map(({ hostname, verified }) => ({
    hostname,
    verified: Boolean(verified),
  })),
  primary: { hostname: site.domain, verified: Boolean(site.domainVerified) },
})

const siteKeyRequired = async (
  req: Parameters<NonNullable<Endpoint['handler']>>[0],
): Promise<Response | Site> => {
  const site = await siteForDomainKey(req)
  if (site) return site

  return Response.json(
    { message: 'این عملیات فقط با کلید سایت ممکن است.' },
    { status: 403, headers: noStore },
  )
}

/**
 * The tenant-facing alias API. A site key may request/remove `www`, campaign
 * subdomains and legacy domains, but it cannot self-verify them: DNS ownership is
 * confirmed by a platform admin in the Sites CMS record before Caddy can issue TLS.
 */
export const siteDomainsEndpoints: Endpoint[] = [
  {
    path: '/site/domains',
    method: 'get',
    handler: async (req) => {
      const site = await siteKeyRequired(req)
      if (site instanceof Response) return site

      return Response.json(aliasesResponse(site), { headers: noStore, status: 200 })
    },
  },
  {
    path: '/site/domains',
    method: 'post',
    handler: async (req) => {
      const site = await siteKeyRequired(req)
      if (site instanceof Response) return site

      let body: { hostname?: unknown }
      try {
        body = (await req.json?.()) ?? {}
      } catch {
        return Response.json(
          { message: 'بدنهٔ درخواست باید JSON باشد.' },
          { status: 400, headers: noStore },
        )
      }

      const hostname = typeof body.hostname === 'string' ? normalizeDomain(body.hostname) : ''
      if (!hostname || !isValidDomain(hostname)) {
        return Response.json(
          { message: domainValidationMessage },
          { status: 400, headers: noStore },
        )
      }

      if (normalizeDomain(site.domain) === hostname) {
        return Response.json(
          { message: 'این نشانی از قبل دامنهٔ اصلی سایت است.' },
          { status: 409, headers: noStore },
        )
      }

      if (aliasesFor(site).some((alias) => normalizeDomain(alias.hostname) === hostname)) {
        return Response.json(
          { message: 'این دامنهٔ فرعی از قبل ثبت شده است.' },
          { status: 409, headers: noStore },
        )
      }

      if (await hostnameIsTaken({ hostname, req, siteId: String(site.id) })) {
        return Response.json(
          { message: 'این دامنه قبلاً به سایت دیگری اختصاص داده شده است.' },
          { status: 409, headers: noStore },
        )
      }

      const updated = await req.payload.update({
        id: site.id,
        collection: 'sites',
        // `verified` is deliberately omitted. A caller holding a tenant key can ask
        // for a hostname but cannot turn a DNS request into an ACME authorisation.
        data: { domains: [...aliasesFor(site), { hostname, verified: false }] },
        depth: 0,
        overrideAccess: true,
        req,
      })

      return Response.json(aliasesResponse(updated as Site), { headers: noStore, status: 201 })
    },
  },
  {
    path: '/site/domains',
    method: 'delete',
    handler: async (req) => {
      const site = await siteKeyRequired(req)
      if (site instanceof Response) return site

      let body: { hostname?: unknown }
      try {
        body = (await req.json?.()) ?? {}
      } catch {
        return Response.json(
          { message: 'بدنهٔ درخواست باید JSON باشد.' },
          { status: 400, headers: noStore },
        )
      }

      const hostname = typeof body.hostname === 'string' ? normalizeDomain(body.hostname) : ''
      if (!hostname || !isValidDomain(hostname)) {
        return Response.json(
          { message: domainValidationMessage },
          { status: 400, headers: noStore },
        )
      }

      const aliases = aliasesFor(site)
      if (!aliases.some((alias) => normalizeDomain(alias.hostname) === hostname)) {
        return Response.json(
          { message: 'این دامنهٔ فرعی برای سایت ثبت نشده است.' },
          { status: 404, headers: noStore },
        )
      }

      const updated = await req.payload.update({
        id: site.id,
        collection: 'sites',
        data: {
          domains: aliases.filter((alias) => normalizeDomain(alias.hostname) !== hostname),
        },
        depth: 0,
        overrideAccess: true,
        req,
      })

      return Response.json(aliasesResponse(updated as Site), { headers: noStore, status: 200 })
    },
  },
]
