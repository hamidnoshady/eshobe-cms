// @vitest-environment node
//
// Same reason as `platform-control.int.spec.ts`: `createLocalReq({ user })` builds a
// real session, and `provisioning.int.spec.ts` documents the jsdom/jose
// incompatibility this whole family of specs shares.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createServer, type Server } from 'node:http'
import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import {
  webhookReplayEndpoint,
  webhookRotateSecretEndpoint,
  webhookTestEndpoint,
} from '@/endpoints/webhooks'
import { signWebhookPayload, verifyWebhookSignature } from '@/lib/saas/crypto'
import { emitPlatformEvent } from '@/platform/webhooks'

/**
 * Outbound webhooks, against a receiver that is actually listening.
 *
 * The whole value of a webhook is that somebody else can verify it, so the fixture
 * here is a real HTTP server that recomputes the signature the way a customer's app
 * would. A test that asserts "we called fetch" proves nothing about the only thing
 * that ever breaks in practice — whether the bytes a receiver signs are the bytes
 * this platform signed.
 *
 * What is pinned:
 *
 *  - the signature covers `<timestamp>.<body>`, so a captured delivery cannot be
 *    replayed against a receiver that enforces a window;
 *  - a failing endpoint is disabled after `webhookMaxFailures`, and a success clears
 *    the counter — a dead receiver must not be retried by hand forever;
 *  - a replay resends the *stored* bytes, not a reconstruction, so the receiver sees
 *    the delivery it missed and not a new event that never happened;
 *  - the signing secret is returned exactly once, at rotation, to an admin session
 *    and to nothing else.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

type Received = {
  body: string
  event: string
  signature: string
  timestamp: string
}

let server: Server
let baseUrl = ''
let received: Received[] = []
/** What the fixture receiver answers next. Set per test. */
let respondWith = { status: 200 }

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: email } },
  })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

const reqAsAdmin = async (extra?: Partial<PayloadRequest>): Promise<PayloadRequest> => {
  const admin = await userByEmail('admin@eshobe.test')
  expect(admin.role).toBe('platformAdmin')
  return createLocalReq(
    { ...(extra ? { req: extra } : {}), user: { ...admin, collection: 'users' } },
    payload,
  )
}

const withBody = (body: unknown): Partial<PayloadRequest> =>
  ({ json: async () => body } as Partial<PayloadRequest>)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = async (res: Response): Promise<Record<string, any>> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await res.json()) as Record<string, any>

/** Wait for the background dispatch `emitPlatformEvent` deliberately does not await. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 400))
}

const createWebhook = async (overrides: Record<string, unknown> = {}) =>
  payload.create({
    collection: 'webhooks',
    data: {
      description: 'گیرندهٔ تست',
      enabled: true,
      events: ['platform.settingsChanged', 'subscription.created'],
      name: 'گیرندهٔ تست',
      // `WEBHOOK_ALLOW_INSECURE` is what lets an http://127.0.0.1 receiver exist at
      // all — in production the URL validator demands https and a public host.
      url: `${baseUrl}/hook`,
      ...overrides,
    } as never,
    overrideAccess: true,
  })

beforeAll(async () => {
  process.env.WEBHOOK_ALLOW_INSECURE = 'true'
  payload = await getPayload({ config })

  server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      received.push({
        body: raw,
        event: String(request.headers['x-eshobe-event'] ?? ''),
        signature: String(request.headers['x-eshobe-signature'] ?? ''),
        timestamp: String(request.headers['x-eshobe-timestamp'] ?? ''),
      })
      response.writeHead(respondWith.status, { 'content-type': 'text/plain' })
      response.end(respondWith.status >= 400 ? 'nope' : 'ok')
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('receiver did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  delete process.env.WEBHOOK_ALLOW_INSECURE
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('signing', () => {
  it('signs the timestamp together with the body, not the body alone', () => {
    const secret = 'whsec_deadbeef'
    const body = '{"event":"platform.settingsChanged"}'

    const atNoon = signWebhookPayload(secret, '1000000000', body)
    const atOne = signWebhookPayload(secret, '1000003600', body)

    // The same bytes signed an hour apart produce different signatures. That is what
    // lets a receiver reject a delivery captured and re-sent later; a signature over
    // the body alone is valid forever.
    expect(atNoon).not.toBe(atOne)
    expect(atNoon).toMatch(/^sha256=[0-9a-f]{64}$/)

    expect(verifyWebhookSignature(atNoon, atNoon)).toBe(true)
    expect(verifyWebhookSignature(atNoon, atOne)).toBe(false)
    // Different lengths must not throw out of `timingSafeEqual`.
    expect(verifyWebhookSignature(atNoon, 'sha256=short')).toBe(false)
  })
})

describe('delivery', () => {
  it('delivers a signed event a receiver can verify', async () => {
    received = []
    respondWith = { status: 200 }

    const webhook = await createWebhook()

    try {
      const rotated = await bodyOf(
        await webhookRotateSecretEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) }))),
      )
      const secret = rotated.secret as string
      expect(secret).toMatch(/^whsec_[0-9a-f]{32}$/)

      const res = await webhookTestEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) })))
      expect(res.status).toBe(200)
      expect((await bodyOf(res)).ok).toBe(true)

      expect(received).toHaveLength(1)
      const hit = received[0]!
      expect(hit.event).toBe('platform.settingsChanged')

      // The receiver's side of the contract, computed here exactly as a customer's
      // app would: same secret, same `<timestamp>.<body>` string, same HMAC.
      expect(verifyWebhookSignature(signWebhookPayload(secret, hit.timestamp, hit.body), hit.signature)).toBe(true)

      // …and a receiver holding the wrong secret must not be able to verify it.
      expect(
        verifyWebhookSignature(signWebhookPayload('whsec_wrong', hit.timestamp, hit.body), hit.signature),
      ).toBe(false)

      const parsed = JSON.parse(hit.body) as Record<string, unknown>
      expect(parsed.event).toBe('platform.settingsChanged')
      expect(parsed.id).toBeTruthy()
      // The signing secret must never appear in the thing it signs.
      expect(hit.body).not.toContain(secret)
    } finally {
      await payload.delete({ collection: 'webhooks', id: String(webhook.id), overrideAccess: true })
    }
  })

  it('returns a rotated secret exactly once, and only to a session', async () => {
    const webhook = await createWebhook({ name: 'چرخش کلید' })

    try {
      const first = await bodyOf(
        await webhookRotateSecretEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) }))),
      )
      expect(first.secret).toMatch(/^whsec_/)

      // Reading the row back gives the mask, never the secret — the one moment the
      // plaintext exists outside the process is the response above, which is why the
      // UI tells the operator to copy it now.
      const stored = await payload.findByID({
        collection: 'webhooks',
        depth: 0,
        id: String(webhook.id),
        overrideAccess: true,
      })
      expect(String(stored.secret ?? '')).not.toContain(first.secret)

      const anonymous = await webhookRotateSecretEndpoint.handler!(
        await createLocalReq({ req: withBody({ id: String(webhook.id) }) }, payload),
      )
      expect(anonymous.status).toBe(403)
    } finally {
      await payload.delete({ collection: 'webhooks', id: String(webhook.id), overrideAccess: true })
    }
  })

  it('records every attempt and disables an endpoint that keeps failing', async () => {
    received = []
    respondWith = { status: 500 }

    const webhook = await createWebhook({ name: 'گیرندهٔ خراب' })
    await webhookRotateSecretEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) })))

    const settings = await payload.findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true })
    const originalMax = (settings as { webhookMaxFailures?: unknown }).webhookMaxFailures

    try {
      await payload.updateGlobal({
        slug: 'platform-settings',
        data: { webhookMaxFailures: 2 },
        overrideAccess: true,
      })

      const first = await bodyOf(
        await webhookTestEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) }))),
      )
      expect(first.ok).toBe(false)
      expect(first.statusCode).toBe(500)

      const afterOne = await payload.findByID({
        collection: 'webhooks',
        depth: 0,
        id: String(webhook.id),
        overrideAccess: true,
      })
      expect(afterOne.consecutiveFailures).toBe(1)
      expect(afterOne.enabled).toBe(true)

      await webhookTestEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) })))

      const afterTwo = await payload.findByID({
        collection: 'webhooks',
        depth: 0,
        id: String(webhook.id),
        overrideAccess: true,
      })
      // Two strikes at a max of two: the endpoint is switched off rather than left to
      // be retried forever. A dead receiver is a support conversation, not a queue.
      expect(afterTwo.consecutiveFailures).toBe(2)
      expect(afterTwo.enabled).toBe(false)
      expect(afterTwo.lastDeliveryOk).toBe(false)

      const { docs: deliveries } = await payload.find({
        collection: 'webhook-deliveries',
        depth: 0,
        limit: 10,
        overrideAccess: true,
        sort: '-createdAt',
        where: { webhook: { equals: String(webhook.id) } },
      })
      expect(deliveries.length).toBeGreaterThanOrEqual(2)
      // The receiver's error page is kept, but truncated — it can contain the
      // receiver's own secrets, and mirroring it wholesale makes that this
      // database's problem.
      expect(String(deliveries[0]!.responseBody ?? '').length).toBeLessThanOrEqual(1000)

      // A success clears the counter: an endpoint that recovers must not stay one
      // failure away from being disabled forever.
      respondWith = { status: 200 }
      await payload.update({
        collection: 'webhooks',
        data: { enabled: true },
        id: String(webhook.id),
        overrideAccess: true,
      })
      await webhookTestEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) })))

      const recovered = await payload.findByID({
        collection: 'webhooks',
        depth: 0,
        id: String(webhook.id),
        overrideAccess: true,
      })
      expect(recovered.consecutiveFailures).toBe(0)
      expect(recovered.lastDeliveryOk).toBe(true)
    } finally {
      await payload.updateGlobal({
        slug: 'platform-settings',
        data: { webhookMaxFailures: (originalMax as number) ?? 10 },
        overrideAccess: true,
      })
      await payload.delete({ collection: 'webhooks', id: String(webhook.id), overrideAccess: true })
    }
  })

  it('replays the stored bytes, not a reconstruction', async () => {
    received = []
    respondWith = { status: 500 }

    const webhook = await createWebhook({ name: 'بازپخش' })
    await webhookRotateSecretEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) })))

    try {
      await webhookTestEndpoint.handler!(await reqAsAdmin(withBody({ id: String(webhook.id) })))
      const failedBody = received.at(-1)!.body

      const { docs } = await payload.find({
        collection: 'webhook-deliveries',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        sort: '-createdAt',
        where: { webhook: { equals: String(webhook.id) } },
      })
      const delivery = docs[0]!

      respondWith = { status: 200 }
      const res = await webhookReplayEndpoint.handler!(
        await reqAsAdmin(withBody({ deliveryId: String(delivery.id) })),
      )
      expect(res.status).toBe(200)
      expect((await bodyOf(res)).ok).toBe(true)

      const replayed = received.at(-1)!
      // Byte-for-byte the payload that failed — same event id, same timestamp inside
      // the body. A reconstruction would carry a fresh id and the receiver would have
      // no way to recognise it as the delivery it missed, or to deduplicate it.
      expect(JSON.parse(replayed.body).id).toBe(JSON.parse(failedBody).id)
      expect(JSON.parse(replayed.body).at).toBe(JSON.parse(failedBody).at)

      const { docs: after } = await payload.find({
        collection: 'webhook-deliveries',
        depth: 0,
        limit: 5,
        overrideAccess: true,
        sort: '-createdAt',
        where: { webhook: { equals: String(webhook.id) } },
      })
      // The replay is its own row with a higher attempt number, not an edit of the
      // failure — the trail of what was tried when is the point of the collection.
      expect(after[0]!.attempt).toBe(Number(delivery.attempt ?? 1) + 1)
      expect(after[0]!.ok).toBe(true)
      expect(after.length).toBeGreaterThan(1)
    } finally {
      await payload.delete({ collection: 'webhooks', id: String(webhook.id), overrideAccess: true })
    }
  })
})

describe('subscription routing', () => {
  it('sends a site’s event only to that site’s webhook and to the platform-wide ones', async () => {
    received = []
    respondWith = { status: 200 }

    const { docs: sites } = await payload.find({
      collection: 'sites',
      depth: 0,
      limit: 2,
      overrideAccess: true,
      sort: 'slug',
    })
    const [siteA, siteB] = sites
    if (!siteA || !siteB) throw new Error('two sites required — run `pnpm seed`')

    const global = await createWebhook({ name: 'همهٔ سایت‌ها' })
    const scopedToA = await createWebhook({ name: 'فقط A', site: String(siteA.id) })
    const scopedToB = await createWebhook({ name: 'فقط B', site: String(siteB.id) })

    for (const hook of [global, scopedToA, scopedToB]) {
      await webhookRotateSecretEndpoint.handler!(await reqAsAdmin(withBody({ id: String(hook.id) })))
    }

    try {
      await emitPlatformEvent(await reqAsAdmin(), {
        event: 'subscription.created',
        message: 'تست مسیریابی',
        site: siteA as unknown as Record<string, unknown>,
      })
      await settle()

      const forEach = async (id: unknown): Promise<number> => {
        const { totalDocs } = await payload.count({
          collection: 'webhook-deliveries',
          overrideAccess: true,
          where: {
            and: [{ event: { equals: 'subscription.created' } }, { webhook: { equals: String(id) } }],
          },
        })
        return totalDocs
      }

      expect(await forEach(global.id)).toBe(1)
      expect(await forEach(scopedToA.id)).toBe(1)
      // The leak that matters on this surface: site B's operator must never receive
      // an event about site A. `site` on a webhook is a filter, not a label.
      expect(await forEach(scopedToB.id)).toBe(0)
    } finally {
      for (const hook of [global, scopedToA, scopedToB]) {
        await payload.delete({ collection: 'webhooks', id: String(hook.id), overrideAccess: true })
      }
    }
  })
})
