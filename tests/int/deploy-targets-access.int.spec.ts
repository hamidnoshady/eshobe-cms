// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import config from '@/payload.config'

import { cmsTypedUser } from './cmsUser'

/**
 * `deploy-targets` from the operator's console: the sibling POS («سایت‌ساز ← زیرساخت»)
 * holds a `role: "platform"` key and nothing else, and read the server list through the
 * collection's REST route. With `access` locked to a platform-admin *session* that read
 * answered 403 and the console showed «کلید پلتفرم پذیرفته نشد» over a key that every
 * other console page accepted.
 *
 * Pinned: a platform key lists, creates and updates rows; a site key and an anonymous
 * caller do not; and the Coolify token a key writes is never read back.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload
let platformKey = ''
let siteKey = ''
const created: string[] = []

const reqWithKey = (key: null | string): Promise<PayloadRequest> =>
  createLocalReq(
    { req: { headers: new Headers(key ? { authorization: `Bearer ${key}` } : {}) } as Partial<PayloadRequest> },
    payload,
  )

const list = async (key: null | string) =>
  payload.find({ collection: 'deploy-targets', depth: 0, overrideAccess: false, req: await reqWithKey(key) })

beforeAll(async () => {
  payload = await getPayload({ config })
  const { docs: admins } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: 'admin@eshobe.test' } },
  })
  const admin = admins[0]!
  expect(admin.role).toBe('platformAdmin')
  const { docs: sites } = await payload.find({ collection: 'sites', depth: 0, limit: 1 })
  if (!sites[0]) throw new Error('No site — run `pnpm seed`')

  const issue = async (body: Record<string, unknown>): Promise<string> => {
    const req = await createLocalReq(
      { req: { json: async () => body } as Partial<PayloadRequest>, user: cmsTypedUser(admin) },
      payload,
    )
    const json = (await (await issueApiKeyEndpoint.handler!(req)).json()) as { key?: string }
    if (!json.key) throw new Error('key issue failed')
    return json.key
  }
  platformKey = await issue({ name: 'deploy-targets (test)', role: 'platform' })
  siteKey = await issue({ name: 'deploy-targets site (test)', role: 'site', siteId: String(sites[0].id) })
})

afterAll(async () => {
  for (const id of created) {
    await payload.delete({ collection: 'deploy-targets', id, overrideAccess: true })
  }
})

describe('deploy-targets with an API key', () => {
  it('refuses an anonymous caller and a site key', async () => {
    await expect(list(null)).rejects.toThrow()
    await expect(list(siteKey)).rejects.toThrow()
  })

  it('a platform key lists, creates and updates, and never reads the token back', async () => {
    const req = await reqWithKey(platformKey)
    const doc = await payload.create({
      collection: 'deploy-targets',
      data: {
        active: false,
        apiToken: 'coolify-token-from-a-platform-key',
        baseUrl: 'https://coolify.test.invalid',
        environmentName: 'production',
        gitSource: 'public',
        key: `platform-key-target-${Date.now()}`,
        name: 'platform-key target',
        projectUuid: 'project-uuid',
        provider: 'coolify',
        serverUuid: 'server-uuid',
      },
      depth: 0,
      overrideAccess: false,
      req,
    })
    created.push(String(doc.id))
    expect((doc as { apiToken?: string }).apiToken ?? '').not.toContain('coolify-token')

    // The token was written (encrypted), not dropped by field access.
    const stored = await payload.db.findOne<{ apiToken?: string; id: string }>({
      collection: 'deploy-targets',
      where: { id: { equals: doc.id } },
    })
    expect(stored?.apiToken).toMatch(/^enc:v1:/)

    const { docs } = await list(platformKey)
    const row = docs.find((d) => String(d.id) === String(doc.id)) as undefined | { apiToken?: string }
    expect(row).toBeDefined()
    expect(row?.apiToken ?? '').not.toContain('coolify-token')

    const updated = await payload.update({
      collection: 'deploy-targets',
      data: { name: 'renamed by key' },
      depth: 0,
      id: doc.id,
      overrideAccess: false,
      req: await reqWithKey(platformKey),
    })
    expect(updated.name).toBe('renamed by key')
  })
})
