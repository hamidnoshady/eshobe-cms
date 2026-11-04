import type { Endpoint, PayloadRequest } from 'payload'

import { requestApiKey } from '@/access/siteApiKey'
import { exchangeCustomerClaimToken } from '@/lib/migration/customer-claims'
import { clientKey, consume } from '@/lib/rate-limit'
import { siteFromRequest } from '@/lib/site-query'

import { json, readJsonBody } from './platformShared'

/**
 * `POST /api/site/customer-claims/exchange` — the storefront half of a
 * migrated customer's account claim.
 *
 * The tenant is never taken from the body. A server-side theme may identify
 * its site with its `role: "site"` API key; a same-origin claim page on the
 * customer's domain may instead rely on `Host`, exactly like checkout. The
 * one-time token is the customer's proof of email ownership, is rate-limited
 * per site/client, and is consumed before the verified identity is returned.
 * This endpoint creates no CMS session and returns no addresses, orders or
 * source provenance: the theme binds the returned `customer.id` to its own
 * storefront account/session.
 */

const resolveSiteId = async (req: PayloadRequest): Promise<null | string> => {
  const key = await requestApiKey(req)
  if (key) return key.role === 'site' ? key.siteId : null

  const site = await siteFromRequest(req)
  return site ? String(site.id) : null
}

export const customerClaimEndpoints: Endpoint[] = [
  {
    handler: async (req) => {
      const { body, error } = await readJsonBody(req)
      if (error || !body) return error ?? json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400)

      const siteId = await resolveSiteId(req)
      if (!siteId) {
        return json(
          { message: 'سایت این درخواست مشخص نیست؛ از دامنه فروشگاه یا کلید سایت استفاده کنید.', ok: false },
          403,
        )
      }

      const throttle = consume({
        key: `customer-claim:${siteId}:${clientKey(req.headers)}`,
        limit: 10,
        windowMs: 10 * 60_000,
      })
      if (!throttle.allowed) {
        return Response.json(
          { message: 'چند لحظه صبر کنید و دوباره تلاش کنید.', ok: false },
          {
            headers: {
              'cache-control': 'no-store',
              'retry-after': String(throttle.retryAfterSeconds),
            },
            status: 429,
          },
        )
      }

      const token = typeof body.token === 'string' ? body.token.trim().slice(0, 200) : ''
      const result = token
        ? await exchangeCustomerClaimToken(req, { siteId, token })
        : null
      if (!result) {
        return json({ message: 'پیوند مطالبه معتبر نیست یا منقضی شده است.', ok: false }, 400)
      }

      return json({ claimedAt: result.claimedAt, customer: result.customer, ok: true })
    },
    method: 'post',
    path: '/site/customer-claims/exchange',
  },
]
