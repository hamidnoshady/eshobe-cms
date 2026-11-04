// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { User } from '@/payload-types'
import config from '@/payload.config'
import { cmsTypedUser } from './cmsUser'
import {
  platformTorobDisconnectEndpoint,
  platformTorobGetEndpoint,
  platformTorobPatchEndpoint,
} from '@/endpoints/platformTorob'
import { handleTorobProductRequest } from '@/lib/torob/product-api'
import { resetRateLimits } from '@/lib/rate-limit'

/**
 * Issue #183 — the platform-only enrollment projection Biza Miz syncs.
 *
 * A site key or tenant editor must not be able to enable their own crawler feed, and a
 * disconnect must actually stop the public endpoint. Run `pnpm seed` first.
 */
let payload: Payload
let siteId = ''
const domain = `torob-enroll-${randomUUID().slice(0, 6)}.example.com`

const userByEmail = async (email: string): Promise<User> => {
  const { docs } = await payload.find({ collection: 'users', depth: 0, limit: 1, where: { email: { equals: email } } })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

const reqAs = async (email: string, body?: unknown): Promise<PayloadRequest> => {
  const user = await userByEmail(email)
  const req = await createLocalReq({ user: cmsTypedUser(user) }, payload)
  req.routeParams = { id: siteId }
  if (body !== undefined) {
    req.text = async () => JSON.stringify(body)
    req.json = async () => body
  }
  return req
}

const call = async (endpoint: typeof platformTorobGetEndpoint, req: PayloadRequest) => {
  const res = (await endpoint.handler(req)) as Response
  return { body: await res.json(), status: res.status }
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  const site = await payload.create({
    collection: 'sites',
    data: {
      availableLocales: ['fa'],
      defaultLocale: 'fa',
      domain,
      name: domain,
      slug: `torob-enroll-${randomUUID().slice(0, 8)}`,
      status: 'active',
      type: 'store',
    },
    depth: 0,
    overrideAccess: true,
  })
  siteId = String(site.id)
}, 180_000)

afterAll(async () => {
  if (siteId) await payload.delete({ collection: 'sites', id: siteId, overrideAccess: true }).catch(() => undefined)
})

describe('platform Torob enrollment', () => {
  it('defaults to fail-closed and reports the canonical endpoint/audience', async () => {
    const { body, status } = await call(platformTorobGetEndpoint, await reqAs('admin@eshobe.test'))
    expect(status).toBe(200)
    expect(body.audience).toBe(domain)
    expect(body.endpoint).toContain(domain)
    expect(body.endpoint).toMatch(/\/torob\/v1\/products$/)
    expect(body.enrollment).toMatchObject({ connected: false, enabled: false, authorizationState: 'not_authorized' })
  })

  it('refuses a tenant owner and an anonymous caller', async () => {
    expect((await call(platformTorobGetEndpoint, await reqAs('shop@eshobe.test'))).status).toBe(403)
    const anon = await createLocalReq({}, payload)
    anon.routeParams = { id: siteId }
    expect((await call(platformTorobGetEndpoint, anon)).status).toBe(403)
  })

  it('syncs full state, refuses a partial patch, and disconnect stops the public feed', async () => {
    const partial = await call(platformTorobPatchEndpoint, await reqAs('admin@eshobe.test', { connected: true }))
    expect(partial.status).toBe(400)

    const synced = await call(
      platformTorobPatchEndpoint,
      await reqAs('admin@eshobe.test', {
        authorizationState: 'authorized',
        connected: true,
        enabled: true,
        shopId: 'biza-shop-1',
      }),
    )
    expect(synced.status).toBe(200)
    expect(synced.body.enrollment).toMatchObject({ connected: true, enabled: true, authorizationState: 'authorized', shopId: 'biza-shop-1' })

    resetRateLimits()
    // No token: an enrolled site now reaches the auth gate (401), not the enrollment 404.
    const enrolled = await handleTorobProductRequest(
      new Request(`http://${domain}/torob/v1/products`, {
        body: JSON.stringify({ page: 1, sort: 'date_added_desc' }),
        headers: { host: domain },
        method: 'POST',
      }),
    )
    expect(enrolled.status).toBe(401)

    const disconnected = await call(platformTorobDisconnectEndpoint, await reqAs('admin@eshobe.test'))
    expect(disconnected.status).toBe(200)
    expect(disconnected.body.enrollment).toMatchObject({ connected: false, enabled: false, authorizationState: 'not_authorized' })

    resetRateLimits()
    const stopped = await handleTorobProductRequest(
      new Request(`http://${domain}/torob/v1/products`, {
        body: JSON.stringify({ page: 1, sort: 'date_added_desc' }),
        headers: { host: domain },
        method: 'POST',
      }),
    )
    expect(stopped.status).toBe(404)
  })

  it('a tenant cannot write the hidden enrollment through the collection API', async () => {
    const owner = await userByEmail('shop@eshobe.test')
    await expect(
      payload.update({
        collection: 'sites',
        id: siteId,
        data: { torob: { connected: true, enabled: true, authorizationState: 'authorized' } },
        user: cmsTypedUser(owner),
      }),
    ).rejects.toThrow()
  })

  it('a domain change resets the enrollment until Biza Miz re-syncs', async () => {
    await payload.update({
      collection: 'sites',
      context: { torobEnrollmentSync: true },
      id: siteId,
      data: { torob: { connected: true, enabled: true, authorizationState: 'authorized', syncedAt: new Date().toISOString() } },
      depth: 0,
      overrideAccess: true,
    })
    const moved = await payload.update({
      collection: 'sites',
      id: siteId,
      data: { domain: `moved-${domain}` },
      depth: 0,
      overrideAccess: true,
    })
    expect(moved.torob).toMatchObject({ connected: false, enabled: false, authorizationState: 'not_authorized' })
  })
})
