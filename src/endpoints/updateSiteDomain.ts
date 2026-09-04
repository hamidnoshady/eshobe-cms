import type { Endpoint } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'

const noStore = { 'cache-control': 'no-store' }

const DOMAIN_PATTERN = /^[a-z0-9.-]+$/

/**
 * `PATCH /api/site/domain` — the one write path that lets a site change its own
 * domain after provisioning. Deliberately key-scoped rather than opened up on
 * the `sites` collection itself: `Sites.access.update` stays `authenticated`
 * (admin-session only) for everything else, and this endpoint is the sole
 * exception, gated to exactly the one field a site's own credential should be
 * able to move.
 *
 * Only a `role: "site"` key may call this — never a platform key (provisioning
 * and key lifecycle only, per `WAVE-9.md` §9.4) and never `Host` (the caller is
 * *changing* the value `Host` would otherwise resolve by). Changing the domain
 * always resets `domainVerified` to `false`: the new host has not been checked
 * against this server's DNS yet, and a stale "verified" would let TLS issuance
 * (`domainCheck`) or the public site route trust a domain nobody confirmed.
 */
export const updateSiteDomain: Endpoint = {
  path: '/site/domain',
  method: 'patch',
  handler: async (req) => {
    const key = await requestApiKey(req)
    if (!key || key.role !== 'site' || !key.siteId) {
      return Response.json({ message: 'این عملیات فقط با کلید سایت ممکن است.' }, { status: 403, headers: noStore })
    }

    let body: { domain?: unknown }
    try {
      body = (await req.json?.()) ?? {}
    } catch {
      return Response.json({ message: 'بدنهٔ درخواست باید JSON باشد.' }, { status: 400, headers: noStore })
    }

    const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
    if (!domain || !DOMAIN_PATTERN.test(domain)) {
      return Response.json(
        { message: 'دامنه باید فقط میزبان باشد: بدون //:http، بدون پورت و بدون مسیر.' },
        { status: 400, headers: noStore },
      )
    }

    const { docs: clashes } = await req.payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ domain: { equals: domain } }, { id: { not_equals: key.siteId } }] },
    })
    if (clashes.length) {
      return Response.json({ message: 'این دامنه قبلاً ثبت شده است.' }, { status: 409, headers: noStore })
    }

    const updated = await req.payload.update({
      id: key.siteId,
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
