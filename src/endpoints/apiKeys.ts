import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'

/**
 * WAVE-9 §9.4 — key lifecycle. Platform-admin session or a `role: "platform"` key
 * only, the same boundary `provisionSiteEndpoint` draws: issuing or revoking a
 * credential is an operator action, never something a site's own key can do to
 * itself or to another site's key.
 */
const requireOperator = async (req: PayloadRequest): Promise<boolean> =>
  isPlatformAdminOrPlatformKey(req, isPlatformAdmin(req.user))

const noStore = { 'cache-control': 'no-store' }

/** `POST /api/api-keys/issue` — the raw key comes back exactly once, in this response. */
export const issueApiKeyEndpoint: Endpoint = {
  path: '/api-keys/issue',
  method: 'post',
  handler: async (req) => {
    if (!(await requireOperator(req))) {
      return Response.json({ message: 'فقط برای مدیر پلتفرم ممکن است.' }, { status: 403, headers: noStore })
    }

    let body: { name?: unknown; role?: unknown; siteId?: unknown }
    try {
      body = (await req.json?.()) ?? {}
    } catch {
      return Response.json({ message: 'بدنهٔ درخواست باید JSON باشد.' }, { status: 400, headers: noStore })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const role = body.role === 'platform' ? 'platform' : body.role === 'site' ? 'site' : null

    if (!name || !role) {
      return Response.json({ message: 'نام و نوع کلید الزامی است.' }, { status: 400, headers: noStore })
    }

    if (role === 'site' && typeof body.siteId !== 'string') {
      return Response.json({ message: 'کلید «سایت» به شناسهٔ سایت نیاز دارد.' }, { status: 400, headers: noStore })
    }

    try {
      const doc = await req.payload.create({
        collection: 'api-keys',
        data:
          role === 'site' ? { name, role, site: body.siteId as string } : { name, role },
        overrideAccess: true,
        req,
      })

      const raw = req.context.eshobeIssuedApiKey as string | undefined
      if (!raw) {
        // The minting hook did not run — never hand back a doc with no usable key.
        req.payload.logger.error('api-keys/issue: no raw key stashed on req.context')
        return Response.json({ message: 'صدور کلید ناموفق بود.' }, { status: 500, headers: noStore })
      }

      return Response.json(
        { id: String(doc.id), key: raw, name: doc.name, prefix: doc.keyPrefix, role: doc.role },
        { status: 201, headers: noStore },
      )
    } catch (error) {
      if (error instanceof Error && /site/i.test(error.message)) {
        return Response.json({ message: 'سایت موردنظر پیدا نشد.' }, { status: 400, headers: noStore })
      }
      req.payload.logger.error(error)
      return Response.json({ message: 'صدور کلید ناموفق بود.' }, { status: 500, headers: noStore })
    }
  },
}

/** `GET /api/api-keys/list?siteId=` — masked summaries, never the raw key. */
export const listApiKeysEndpoint: Endpoint = {
  path: '/api-keys/list',
  method: 'get',
  handler: async (req) => {
    if (!(await requireOperator(req))) {
      return Response.json({ message: 'فقط برای مدیر پلتفرم ممکن است.' }, { status: 403, headers: noStore })
    }

    const siteId = typeof req.query?.siteId === 'string' ? req.query.siteId : undefined

    const { docs } = await req.payload.find({
      collection: 'api-keys',
      depth: 0,
      limit: 200,
      overrideAccess: true,
      pagination: false,
      req,
      sort: '-createdAt',
      ...(siteId ? { where: { site: { equals: siteId } } } : {}),
    })

    return Response.json(
      {
        docs: docs.map((doc) => ({
          id: String(doc.id),
          createdAt: doc.createdAt,
          lastUsedAt: doc.lastUsedAt ?? null,
          name: doc.name,
          prefix: doc.keyPrefix ?? '',
          role: doc.role,
          siteId: doc.role === 'site' ? idOf(doc.site) : null,
        })),
      },
      { status: 200, headers: noStore },
    )
  },
}

/** `POST /api/api-keys/revoke` — disables a key; the row stays, for audit. */
export const revokeApiKeyEndpoint: Endpoint = {
  path: '/api-keys/revoke',
  method: 'post',
  handler: async (req) => {
    if (!(await requireOperator(req))) {
      return Response.json({ message: 'فقط برای مدیر پلتفرم ممکن است.' }, { status: 403, headers: noStore })
    }

    let body: { id?: unknown }
    try {
      body = (await req.json?.()) ?? {}
    } catch {
      return Response.json({ message: 'بدنهٔ درخواست باید JSON باشد.' }, { status: 400, headers: noStore })
    }

    if (typeof body.id !== 'string' || !body.id) {
      return Response.json({ message: 'شناسهٔ کلید الزامی است.' }, { status: 400, headers: noStore })
    }

    try {
      await req.payload.update({
        id: body.id,
        collection: 'api-keys',
        data: { disabledAt: new Date().toISOString() },
        overrideAccess: true,
        req,
      })
      return Response.json({ ok: true }, { status: 200, headers: noStore })
    } catch (error) {
      req.payload.logger.error(error)
      return Response.json({ message: 'کلید موردنظر پیدا نشد.' }, { status: 404, headers: noStore })
    }
  },
}

export const apiKeysEndpoints: Endpoint[] = [issueApiKeyEndpoint, listApiKeysEndpoint, revokeApiKeyEndpoint]
