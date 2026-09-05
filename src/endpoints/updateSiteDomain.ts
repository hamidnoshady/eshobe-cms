import type { Endpoint, PayloadRequest } from 'payload'

import type { Site } from '@/payload-types'

import { requestApiKey } from '@/access/siteApiKey'
import {
  domainValidationMessage,
  isValidDomain,
  normalizeDomain,
  siteHostnames,
} from '@/lib/domains'

const noStore = { 'cache-control': 'no-store' }

/** The one site a valid site key is allowed to modify. */
export const siteForDomainKey = async (req: PayloadRequest): Promise<Site | null> => {
  const key = await requestApiKey(req)
  if (!key || key.role !== 'site' || !key.siteId) return null

  const site = await req.payload.findByID({
    id: key.siteId,
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })

  return site ?? null
}

/**
 * Checks both primary and alias hostnames before a domain write. The collection
 * hook and a PostgreSQL trigger enforce the same invariant for admin writes and
 * concurrent requests; this preflight exists to return an actionable API error.
 */
export const hostnameIsTaken = async ({
  hostname,
  req,
  siteId,
}: {
  hostname: string
  req: PayloadRequest
  siteId: string
}): Promise<boolean> => {
  const { docs } = await req.payload.find({
    collection: 'sites',
    depth: 0,
    limit: 10,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      or: [{ domain: { equals: hostname } }, { 'domains.hostname': { equals: hostname } }],
    },
  })

  return docs.some((site) => String(site.id) !== siteId && siteHostnames(site).includes(hostname))
}

/**
 * `PATCH /api/site/domain` — changes a site's canonical hostname.
 *
 * The owner can use its site API key, but not a platform key. This is intentionally
 * separate from aliases: moving the canonical URL is a high-impact action and
 * always clears its TLS approval, while an alias is created pending verification
 * through `POST /api/site/domains`.
 */
export const updateSiteDomain: Endpoint = {
  path: '/site/domain',
  method: 'patch',
  handler: async (req) => {
    const site = await siteForDomainKey(req)
    if (!site) {
      return Response.json(
        { message: 'این عملیات فقط با کلید سایت ممکن است.' },
        { status: 403, headers: noStore },
      )
    }

    let body: { domain?: unknown }
    try {
      body = (await req.json?.()) ?? {}
    } catch {
      return Response.json(
        { message: 'بدنهٔ درخواست باید JSON باشد.' },
        { status: 400, headers: noStore },
      )
    }

    const domain = typeof body.domain === 'string' ? normalizeDomain(body.domain) : ''
    if (!domain || !isValidDomain(domain)) {
      return Response.json({ message: domainValidationMessage }, { status: 400, headers: noStore })
    }

    // A tenant cannot promote one of its existing aliases by accident: first remove
    // it from the alias list, then make it canonical, which preserves the invariant
    // that every hostname occurs exactly once in the platform.
    if (siteHostnames(site).includes(domain) && normalizeDomain(site.domain) !== domain) {
      return Response.json(
        {
          message:
            'این نشانی اکنون دامنهٔ فرعی همین سایت است؛ ابتدا آن را از فهرست دامنه‌های فرعی حذف کنید.',
        },
        { status: 409, headers: noStore },
      )
    }

    if (await hostnameIsTaken({ hostname: domain, req, siteId: String(site.id) })) {
      return Response.json(
        { message: 'این دامنه قبلاً ثبت شده است.' },
        { status: 409, headers: noStore },
      )
    }

    const updated = await req.payload.update({
      id: site.id,
      collection: 'sites',
      data: { domain, domainVerified: false },
      depth: 0,
      overrideAccess: true,
      req,
    })

    return Response.json(
      { domain: updated.domain, domainVerified: Boolean(updated.domainVerified) },
      { status: 200, headers: noStore },
    )
  },
}
