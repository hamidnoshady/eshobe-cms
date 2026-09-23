import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isPlatformAdminOrPlatformKey } from '@/access/siteApiKey'
import { CoolifyClient } from '@/deploy/coolify'
import { loadTarget } from '@/deploy/service'
import { isUuid } from '@/lib/ids'

/**
 * `POST /api/deploy-targets/self-test` — prove a Coolify connection before any
 * customer's site depends on it.
 *
 * The same shape as `/api/storage-connections/self-test` and the payment gateways'
 * probe, and for the same reason: the only way to tell "the token was mistyped" from
 * "Coolify is down" is to have asked once, successfully, and written the answer onto
 * the row.
 *
 * It asks two questions, not one. A token that authenticates is half an answer — a
 * token scoped to a different Coolify *team* authenticates perfectly and then cannot
 * see the server whose UUID the operator typed. That failure would otherwise first
 * appear as a customer's deploy dying on an opaque 404.
 *
 * A **collection endpoint** (`DeployTargets.endpoints`): Payload dispatches
 * `/api/<first-segment>/…` against that collection's own endpoints when the first
 * segment is a collection slug and never falls back to the top-level array. See the
 * rule written out in `src/endpoints/apiKeys.ts`.
 */

const noStore = { 'cache-control': 'no-store' }

const json = (body: Record<string, unknown>, status = 200): Response =>
  Response.json(body, { headers: noStore, status })

const requireOperator = async (req: PayloadRequest): Promise<boolean> =>
  isPlatformAdminOrPlatformKey(req, isPlatformAdmin(req.user))

export const deployTargetSelfTest: Endpoint = {
  path: '/self-test',
  method: 'post',
  handler: async (req) => {
    if (!(await requireOperator(req))) {
      return json({ message: 'فقط کارکنان سکو می‌توانند خودآزمایی اجرا کنند.', ok: false }, 403)
    }

    const body = (await req.json?.().catch(() => null)) as null | { id?: unknown }
    const id = typeof body?.id === 'string' ? body.id : null

    if (!isUuid(id)) return json({ message: 'شناسهٔ سرور نامعتبر است.', ok: false }, 400)

    const target = await loadTarget(req, id)
    if (!target) {
      return json({ message: 'سرور پیدا نشد یا توکن آن خوانا نیست.', ok: false }, 404)
    }

    const startedAt = Date.now()
    const result = await new CoolifyClient(target).selfTest()
    const elapsed = Date.now() - startedAt

    if (!result.ok) {
      const detail = `${result.message} (${elapsed}ms)`
      await req.payload.update({
        collection: 'deploy-targets',
        data: {
          lastSelfTestAt: new Date().toISOString(),
          lastSelfTestDetail: detail,
          lastSelfTestOk: false,
        },
        depth: 0,
        id,
        overrideAccess: true,
        req,
      })
      return json({ detail: result.detail ?? null, message: detail, ok: false }, 502)
    }

    if (!result.data.serverFound) {
      // Authenticated, and useless. Recorded as a failure because deploying against
      // it would fail — a green tick here would be a lie that costs an outage.
      const detail = `توکن معتبر است اما سرور ${target.serverUuid} در این حساب دیده نمی‌شود (${result.data.servers} سرور، ${elapsed}ms).`
      await req.payload.update({
        collection: 'deploy-targets',
        data: {
          lastSelfTestAt: new Date().toISOString(),
          lastSelfTestDetail: detail,
          lastSelfTestOk: false,
        },
        depth: 0,
        id,
        overrideAccess: true,
        req,
      })
      return json({ message: detail, ok: false }, 422)
    }

    const detail = `اتصال برقرار است؛ سرور پیدا شد (${result.data.servers} سرور، ${elapsed}ms).`
    await req.payload.update({
      collection: 'deploy-targets',
      data: {
        lastSelfTestAt: new Date().toISOString(),
        lastSelfTestDetail: detail,
        lastSelfTestOk: true,
      },
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })

    return json({ message: detail, ok: true, servers: result.data.servers })
  },
}

export const deployTargetEndpoints: Endpoint[] = [deployTargetSelfTest]
