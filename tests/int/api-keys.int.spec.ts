// @vitest-environment node
//
// jose's JWT bits aren't in play here, but `createLocalReq({ user })` builds a
// real session the same way `provisioning.int.spec.ts` does, and that spec
// documents the jsdom/jose incompatibility for the whole suite to share.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint, listApiKeysEndpoint, revokeApiKeyEndpoint } from '@/endpoints/apiKeys'
import { idOf } from '@/lib/ids'

/**
 * WAVE-9 §9.4 — the credential a headless client (the cafe-restaurant-pos POS)
 * authenticates with from a non-customer origin. Run `pnpm seed` first.
 */
let payload: Payload

const siteId = { acme: '', studio: '' }

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({ collection: 'users', depth: 0, limit: 1, where: { email: { equals: email } } })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

const reqAsAdmin = async (): Promise<PayloadRequest> => {
  const admin = await userByEmail('admin@eshobe.test')
  expect(admin.role).toBe('platformAdmin')
  return createLocalReq({ user: { ...admin, collection: 'users' } }, payload)
}

/**
 * A request carrying a bearer key. `host` mirrors the real client
 * (`cafe-restaurant-pos`'s `src/lib/cms/client.ts` forwards the site's own
 * domain as `Host` on every call, key included) — pass one to test the
 * realistic shape, omit it to test the key alone (the platform-key checks
 * below, which have no site to name a `Host` for).
 */
const reqWithKey = (key: string, host?: string): Promise<PayloadRequest> =>
  createLocalReq(
    {
      req: {
        headers: new Headers({ authorization: `Bearer ${key}`, ...(host ? { host } : {}) }),
      } as Partial<PayloadRequest>,
    },
    payload,
  )

/** An admin-session request whose body is `body` — for the JSON POST endpoints. */
const adminReqWithBody = async (body: unknown): Promise<PayloadRequest> => {
  const admin = await reqAsAdmin()
  return createLocalReq(
    { req: { json: async () => body } as Partial<PayloadRequest>, user: admin.user },
    payload,
  )
}

const issueKey = async (input: { name: string; role: 'platform' | 'site'; siteId?: string }) => {
  const req = await adminReqWithBody(input)
  const response = await issueApiKeyEndpoint.handler(req)
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; key: string; prefix: string; role: string }
}

const read = <T = Record<string, unknown>>(req: PayloadRequest, collection: string, where?: Record<string, unknown>) =>
  (payload.find as (args: unknown) => Promise<{ docs: T[] }>)({
    collection,
    depth: 0,
    overrideAccess: false,
    pagination: false,
    req,
    where,
  }).then(({ docs }) => docs)

beforeAll(async () => {
  payload = await getPayload({ config: await config })

  const { docs } = await payload.find({ collection: 'sites', depth: 0, pagination: false })
  for (const site of docs as { domain: string; id: string }[]) {
    if (site.domain === 'acme.localhost') siteId.acme = site.id
    if (site.domain === 'studio.localhost') siteId.studio = site.id
  }
  expect(siteId.acme).toBeTruthy()
  expect(siteId.studio).toBeTruthy()
})

describe('issuing a key', () => {
  it('refuses anyone who is not a platform admin or a platform key', async () => {
    const acmeOwner = await userByEmail('acme@eshobe.test')
    const req = await createLocalReq(
      {
        req: { json: async () => ({ name: 'x', role: 'site', siteId: siteId.acme }) } as Partial<PayloadRequest>,
        user: { ...acmeOwner, collection: 'users' },
      },
      payload,
    )

    const response = await issueApiKeyEndpoint.handler(req)
    expect(response.status).toBe(403)
  })

  it('mints a site key, returns the raw value once, and never stores it', async () => {
    const issued = await issueKey({ name: 'POS test key', role: 'site', siteId: siteId.acme })

    expect(issued.key).toMatch(/^eshobe_live_[0-9a-f]{40}$/)
    expect(issued.prefix).toBe(issued.key.slice(0, issued.prefix.length))

    const stored = await payload.findByID({ id: issued.id, collection: 'api-keys', depth: 0, overrideAccess: true, showHiddenFields: true })
    expect(JSON.stringify(stored)).not.toContain(issued.key)
  })
})

describe('a site key', () => {
  it('reads only its own site, drafts included, and cannot be widened to another', async () => {
    const issued = await issueKey({ name: 'read test', role: 'site', siteId: siteId.acme })

    // Draft an existing acme page — an anonymous host-scoped read would never
    // see it (`_status: published` is required there); a site key should,
    // being that site's own editor token.
    const { docs: acmePages } = await payload.find({
      collection: 'pages',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { and: [{ site: { equals: siteId.acme } }, { _status: { equals: 'published' } }] },
    })
    const page = acmePages[0]
    if (!page) throw new Error('acme.localhost has no published page — run `pnpm seed`')

    await payload.update({ id: page.id, collection: 'pages', data: { _status: 'draft' }, overrideAccess: true })

    try {
      // A realistic call: the client forwards the site's own domain as `Host`
      // alongside the key (`src/lib/cms/client.ts`).
      const req = await reqWithKey(issued.key, 'acme.localhost')
      const onOwnSite = await read(req, 'pages', { id: { equals: page.id } })
      expect(onOwnSite).toHaveLength(1)

      // A `where` that names a different site intersects with the key's own
      // site and yields nothing — the same "narrow, never widen" property
      // `src/access/siteRead.ts` documents for the host-scoped case.
      const widened = await read(req, 'pages', { site: { equals: siteId.studio } })
      expect(widened).toHaveLength(0)

      // Without the key at all (an anonymous visitor on the same host), the
      // draft is invisible — the key is what unlocked it, not the host alone.
      const anonymousReq = await createLocalReq(
        { req: { headers: new Headers({ host: 'acme.localhost' }) } as Partial<PayloadRequest> },
        payload,
      )
      const anonymously = await read(anonymousReq, 'pages', { id: { equals: page.id } })
      expect(anonymously).toHaveLength(0)
    } finally {
      await payload.update({ id: page.id, collection: 'pages', data: { _status: 'published' }, overrideAccess: true })
    }
  })

  it('creates a product on its own site and cannot be made to name a different one', async () => {
    const issued = await issueKey({ name: 'write test', role: 'site', siteId: siteId.acme })
    const req = await reqWithKey(issued.key)

    const created = await payload.create({
      collection: 'products',
      overrideAccess: false,
      req,
      // Attempting to name a different site is exactly what `forceApiKeySite`
      // (`src/access/siteApiKey.ts`) exists to ignore.
      data: { price: 1000, site: siteId.studio, title: 'محصول آزمایشی WAVE-9' } as never,
    })

    try {
      expect(idOf((created as { site: unknown }).site)).toBe(siteId.acme)
    } finally {
      await payload.delete({ id: created.id, collection: 'products', overrideAccess: true })
    }
  })

  it('cannot read or write a collection it holds no grant on', async () => {
    const issued = await issueKey({ name: 'sites test', role: 'site', siteId: siteId.acme })
    const req = await reqWithKey(issued.key)

    await expect(read(req, 'sites')).rejects.toThrow()
  })

  it('loses its elevated grant immediately once revoked', async () => {
    const issued = await issueKey({ name: 'revoke test', role: 'site', siteId: siteId.acme })

    const { docs: acmePages } = await payload.find({
      collection: 'pages',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { and: [{ site: { equals: siteId.acme } }, { _status: { equals: 'published' } }] },
    })
    const page = acmePages[0]
    if (!page) throw new Error('acme.localhost has no published page — run `pnpm seed`')
    await payload.update({ id: page.id, collection: 'pages', data: { _status: 'draft' }, overrideAccess: true })

    try {
      // While live, the key still unlocks the draft — proves the fixture and
      // the key actually agree before revocation is the thing under test.
      const before = await read(await reqWithKey(issued.key, 'acme.localhost'), 'pages', { id: { equals: page.id } })
      expect(before).toHaveLength(1)

      const revokeResponse = await revokeApiKeyEndpoint.handler(await adminReqWithBody({ id: issued.id }))
      expect(revokeResponse.status).toBe(200)

      // `apiKeyAware` no longer recognises the key, so the request falls back
      // to the ordinary anonymous, `Host`-scoped, published-only read — the
      // draft is invisible again, immediately, with no separate cache to bust.
      const after = await read(await reqWithKey(issued.key, 'acme.localhost'), 'pages', { id: { equals: page.id } })
      expect(after).toHaveLength(0)
    } finally {
      await payload.update({ id: page.id, collection: 'pages', data: { _status: 'published' }, overrideAccess: true })
    }
  })
})

describe('a platform key', () => {
  it('lists every site but reads no content', async () => {
    const issued = await issueKey({ name: 'platform test', role: 'platform' })
    const req = await reqWithKey(issued.key)

    const sites = await read(req, 'sites')
    expect(sites.length).toBeGreaterThanOrEqual(2)

    await expect(read(req, 'pages')).rejects.toThrow()
  })

  it('is listed back masked, never with the raw key', async () => {
    const issued = await issueKey({ name: 'list test', role: 'platform' })

    const listReq = await createLocalReq({ user: (await reqAsAdmin()).user }, payload)
    const response = await listApiKeysEndpoint.handler(listReq)
    const body = (await response.json()) as { docs: { id: string; prefix: string }[] }

    const row = body.docs.find((doc) => doc.id === issued.id)
    expect(row?.prefix).toBe(issued.prefix)
    expect(JSON.stringify(body)).not.toContain(issued.key)
  })
})
