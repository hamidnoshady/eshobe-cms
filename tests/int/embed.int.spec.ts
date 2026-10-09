// @vitest-environment node
//
// `payload.login` signs a JWT (jose), which cannot run under vitest's jsdom realm — the
// same reason `provisioning.int.spec.ts` and `platform-control.int.spec.ts` run in node.
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import { writeUnlessPublishing } from '@/access/publish'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { embedEnterEndpoint, platformSiteEmbedSessionEndpoint } from '@/endpoints/platformEmbed'
import {
  EMBED_MARKER_COOKIE,
  embedCodeKey,
  embedTargetPath,
  embedUserEmail,
  embedUserPassword,
  isEmbedCollection,
  serializeEmbedCookie,
} from '@/lib/embed'
import type { User } from '@/payload-types'
import config from '@/payload.config'

import { cmsTypedUser } from './cmsUser'

/**
 * The POS's edit modal: a platform key mints a one-time entry URL, the iframe spends it
 * and lands on one admin document as a per-site service user.
 *
 * What is pinned: only a platform credential mints (a site key and an anonymous caller
 * do not); a document of another site is refused; a code works once and expires; the
 * service user holds exactly one tenant row whose role follows `canPublish`; and
 * `writeUnlessPublishing` — the one function behind the Publish button *and* REST —
 * agrees with that role.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload
const siteId = { acme: '', shop: '' }
let acmePostId = ''
let shopPostId = ''
let platformKey = ''
let siteKey = ''

const bodyOf = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>

const reqWithKey = (key: null | string, extra: Partial<PayloadRequest>): Promise<PayloadRequest> =>
  createLocalReq(
    {
      req: {
        headers: new Headers(key ? { authorization: `Bearer ${key}` } : {}),
        ...extra,
      } as Partial<PayloadRequest>,
    },
    payload,
  )

const mint = async (
  key: null | string,
  id: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  platformSiteEmbedSessionEndpoint.handler!(
    await reqWithKey(key, { json: async () => body, routeParams: { id } } as Partial<PayloadRequest>),
  )

const codeOf = (url: string): string => new URL(url).searchParams.get('code') ?? ''

const enter = async (code: string): Promise<Response> =>
  embedEnterEndpoint.handler!(
    await reqWithKey(null, { url: `http://localhost:3000/api/embed/enter?code=${code}` } as Partial<PayloadRequest>),
  )

const embedUser = async (site: string, access: 'editor' | 'owner'): Promise<User> => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: embedUserEmail(site, access) } },
  })
  if (!docs[0]) throw new Error('embed user missing')
  return docs[0]
}

beforeAll(async () => {
  payload = await getPayload({ config })

  for (const slug of ['acme', 'shop'] as const) {
    const { docs } = await payload.find({ collection: 'sites', depth: 0, limit: 1, where: { slug: { equals: slug } } })
    if (!docs[0]) throw new Error(`Site ${slug} missing — run \`pnpm seed\``)
    siteId[slug] = String(docs[0].id)
  }
  const postOf = async (site: string): Promise<string> => {
    const { docs } = await payload.find({
      collection: 'posts',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: site } },
    })
    if (!docs[0]) throw new Error('seed has no post for the site')
    return String(docs[0].id)
  }
  acmePostId = await postOf(siteId.acme)
  shopPostId = await postOf(siteId.shop)

  const { docs: admins } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: 'admin@eshobe.test' } },
  })
  const admin = admins[0]!
  // A fixture that is accidentally not an admin would make every mint below 403 for the wrong reason.
  expect(admin.role).toBe('platformAdmin')
  const issue = async (body: Record<string, unknown>): Promise<string> => {
    const req = await createLocalReq(
      { req: { json: async () => body } as Partial<PayloadRequest>, user: cmsTypedUser(admin) },
      payload,
    )
    const json = (await (await issueApiKeyEndpoint.handler!(req)).json()) as { key?: string }
    if (!json.key) throw new Error('key issue failed')
    return json.key
  }
  platformKey = await issue({ name: 'embed (test)', role: 'platform' })
  siteKey = await issue({ name: 'embed site (test)', role: 'site', siteId: siteId.acme })
})

describe('pure helpers', () => {
  it('allowlists the collections and builds the landing path itself', () => {
    expect(isEmbedCollection('posts')).toBe(true)
    expect(isEmbedCollection('pages')).toBe(true)
    expect(isEmbedCollection('users')).toBe(false)
    expect(isEmbedCollection('../users')).toBe(false)
    expect(embedTargetPath('posts')).toBe('/admin/collections/posts/create')
    expect(embedTargetPath('pages', 'abc')).toBe('/admin/collections/pages/abc')
  })

  it('stores only a hash of the code and derives, not stores, the password', () => {
    expect(embedCodeKey('abc')).toMatch(/^embed:[0-9a-f]{64}$/)
    expect(embedCodeKey('abc')).not.toContain('abc')
    const email = embedUserEmail('s', 'editor')
    expect(embedUserPassword('k1', email)).toBe(embedUserPassword('k1', email))
    expect(embedUserPassword('k1', email)).not.toBe(embedUserPassword('k2', email))
  })

  it('words the cookie for a cross-site frame only when it can be Secure', () => {
    const spec = { httpOnly: true, maxAge: 7200, name: 'payload-token', value: 'a b' }
    const https = serializeEmbedCookie(spec, true)
    expect(https).toContain('SameSite=None')
    expect(https).toContain('Partitioned')
    expect(https).toContain('Secure')
    expect(https).toContain('HttpOnly')
    expect(https).toContain('payload-token=a%20b')
    const http = serializeEmbedCookie(spec, false)
    expect(http).toContain('SameSite=Lax')
    expect(http).not.toContain('Secure')
  })
})

describe('POST /platform/sites/:id/embed-session', () => {
  it('refuses an anonymous caller and a site key', async () => {
    expect((await mint(null, siteId.acme, { collection: 'posts' })).status).toBe(403)
    expect((await mint(siteKey, siteId.acme, { collection: 'posts' })).status).toBe(403)
  })

  it('rejects an unknown site, a bad collection and a malformed id', async () => {
    expect((await mint(platformKey, '00000000-0000-4000-8000-000000000000', { collection: 'posts' })).status).toBe(404)
    expect((await mint(platformKey, 'nope', { collection: 'posts' })).status).toBe(400)
    expect((await mint(platformKey, siteId.acme, { collection: 'users' })).status).toBe(400)
    expect((await mint(platformKey, siteId.acme, { collection: 'posts', id: 'x' })).status).toBe(400)
  })

  it("refuses a document that belongs to another site", async () => {
    const res = await mint(platformKey, siteId.acme, { collection: 'posts', id: shopPostId })
    expect(res.status).toBe(404)
  })

  it('mints a url, keeping only the hash of the code, and a user with one tenant', async () => {
    const res = await mint(platformKey, siteId.acme, { canPublish: false, collection: 'posts', id: acmePostId })
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    const code = codeOf(String(body.url))
    expect(new URL(String(body.url)).pathname).toBe('/api/embed/enter')
    expect(code.length).toBeGreaterThanOrEqual(32)
    expect(await payload.kv.has(embedCodeKey(code))).toBe(true)
    expect(await payload.kv.has(`embed:${code}`)).toBe(false)

    const editor = await embedUser(siteId.acme, 'editor')
    expect(editor.role).toBe('user')
    expect(editor.tenants).toHaveLength(1)
    expect(String((editor.tenants![0]!.tenant as { id?: string })?.id ?? editor.tenants![0]!.tenant)).toBe(siteId.acme)
    expect(editor.tenants![0]!.role).toBe('editor')
  })

  it('canPublish picks the owner user, not the editor', async () => {
    await mint(platformKey, siteId.acme, { canPublish: true, collection: 'pages' })
    const owner = await embedUser(siteId.acme, 'owner')
    expect(owner.role).toBe('user')
    expect(owner.tenants![0]!.role).toBe('owner')
    // The `canPublish` claim is a boolean: a truthy string must not escalate.
    await mint(platformKey, siteId.shop, { canPublish: 'true', collection: 'pages' })
    expect((await embedUser(siteId.shop, 'editor')).tenants![0]!.role).toBe('editor')
  })
})

describe('GET /embed/enter', () => {
  const fresh = async (body: Record<string, unknown>): Promise<string> =>
    codeOf(String((await bodyOf(await mint(platformKey, siteId.acme, body))).url))

  it('lands on the document, sets the cookies, and spends the code', async () => {
    const code = await fresh({ canPublish: false, collection: 'posts', id: acmePostId })
    const res = await enter(code)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/admin/collections/posts/${acmePostId}`)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const cookies = res.headers.getSetCookie()
    expect(cookies.some((c) => c.startsWith('payload-token='))).toBe(true)
    expect(cookies.some((c) => c.startsWith('payload-token=') && c.includes('HttpOnly'))).toBe(true)
    expect(cookies.some((c) => c.startsWith(`payload-tenant=${siteId.acme}`))).toBe(true)
    expect(cookies.some((c) => c.startsWith(`${EMBED_MARKER_COOKIE}=1`))).toBe(true)

    // Single use.
    expect((await enter(code)).status).toBe(403)
  })

  it('the cookie is a real session for the service user, and only that', async () => {
    const code = await fresh({ canPublish: false, collection: 'posts' })
    const res = await enter(code)
    expect(res.headers.get('location')).toBe('/admin/collections/posts/create')
    const token = decodeURIComponent(
      res.headers.getSetCookie().find((c) => c.startsWith('payload-token='))!.split(';')[0]!.split('=')[1]!,
    )
    const { user } = await payload.auth({ headers: new Headers({ cookie: `payload-token=${token}` }) })
    expect((user as null | User)?.email).toBe(embedUserEmail(siteId.acme, 'editor'))
  })

  it('refuses an unknown, malformed or expired code', async () => {
    expect((await enter('x'.repeat(43))).status).toBe(403)
    expect((await enter('short')).status).toBe(403)
    expect((await enter('')).status).toBe(403)

    const code = await fresh({ collection: 'posts' })
    const key = embedCodeKey(code)
    const grant = await payload.kv.get<{ expiresAt: number }>(key)
    await payload.kv.set(key, { ...grant!, expiresAt: Date.now() - 1 })
    expect((await enter(code)).status).toBe(403)
  })

  it('heals a service user whose password no longer matches the derived one', async () => {
    const editor = await embedUser(siteId.acme, 'editor')
    await payload.update({
      collection: 'users',
      data: { password: 'changed-by-a-site-owner-1234' },
      id: editor.id,
      overrideAccess: true,
    })
    const res = await enter(await fresh({ collection: 'posts' }))
    expect(res.status).toBe(302)
  })
})

describe('what the service users may do', () => {
  const asUser = (user: User) => ({ ...user, collection: 'users' as const })
  const ask = (user: User, data: Record<string, unknown>, id?: string) =>
    writeUnlessPublishing('posts')({
      data,
      id,
      req: { payload, user: asUser(user) } as unknown as PayloadRequest,
    })

  it('an editor drafts but cannot publish; an owner can — on its own site only', async () => {
    const editor = await embedUser(siteId.acme, 'editor')
    const owner = await embedUser(siteId.acme, 'owner')

    expect(await ask(editor, { _status: 'draft', site: siteId.acme })).toBe(true)
    expect(await ask(editor, { _status: 'published', site: siteId.acme })).toBe(false)
    expect(await ask(owner, { _status: 'published', site: siteId.acme })).toBe(true)
    // Same owner, another customer's site: the role is per tenant row.
    expect(await ask(owner, { _status: 'published', site: siteId.shop })).toBe(false)
    // REST shape: no site in the body, the stored document is read for it.
    expect(await ask(owner, { _status: 'published' }, shopPostId)).toBe(false)
    expect(await ask(owner, { _status: 'published' }, acmePostId)).toBe(true)
  })
})
