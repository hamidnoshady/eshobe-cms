// @vitest-environment node
import { createHmac } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@/payload.config'
import { themeGithubWebhookEndpoint } from '@/endpoints/themeGithubWebhook'
import { themePackageSyncEndpoint } from '@/endpoints/platformDeployments'

let payload: Payload
let adminReq: PayloadRequest
let packageId = ''

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`

const pushBody = (repo: string, ref: string, after = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') =>
  JSON.stringify({
    after,
    ref: `refs/heads/${ref}`,
    repository: { full_name: repo },
  })

describe('GitHub theme webhook', () => {
  beforeAll(async () => {
    process.env.GITHUB_THEME_WEBHOOK_SECRET = 'test-webhook-secret-for-theme-packages-32chars'
    payload = await getPayload({ config })
    const user = (
      await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        where: { email: { equals: 'admin@eshobe.test' } },
      })
    ).docs[0]
    adminReq = await createLocalReq({ user: { ...user, collection: 'users' } }, payload)

    const pkg = await payload.create({
      collection: 'theme-packages',
      data: {
        defaultRef: 'main',
        key: `wh-theme-${Date.now()}`,
        name: 'Webhook test theme',
        provider: 'github',
        repository: 'hamidnoshady/nonexistent-theme-repo',
        status: 'draft',
        visibility: 'public',
      },
      overrideAccess: true,
    })
    packageId = String(pkg.id)
  }, 120_000)

  afterAll(async () => {
    delete process.env.GITHUB_THEME_WEBHOOK_SECRET
    if (packageId) {
      await payload.delete({ collection: 'theme-packages', id: packageId, overrideAccess: true })
    }
  })

  const callWebhook = async (body: string, headers: Record<string, string> = {}) => {
    const secret = process.env.GITHUB_THEME_WEBHOOK_SECRET ?? ''
    const req = {
      ...adminReq,
      headers: new Headers({
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': headers['x-github-delivery'] ?? `delivery-${Date.now()}`,
        'x-hub-signature-256': sign(secret, body),
        ...headers,
      }),
      json: undefined,
      text: async () => body,
    } as PayloadRequest & { text: () => Promise<string> }

    return themeGithubWebhookEndpoint.handler(req)
  }

  it('refuses invalid signatures', async () => {
    const body = pushBody('hamidnoshady/nonexistent-theme-repo', 'main')
    const req = {
      ...adminReq,
      headers: new Headers({
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=deadbeef',
      }),
      text: async () => body,
    } as PayloadRequest & { text: () => Promise<string> }

    const res = await themeGithubWebhookEndpoint.handler(req)
    expect(res?.status).toBe(401)
  })

  it('ignores unrelated repositories', async () => {
    const body = pushBody('other/vendor-repo', 'main')
    const res = await callWebhook(body)
    expect(res?.status).toBe(200)
    const json = await res?.json()
    expect(json.skipped).toBe(true)
  })

  it('ignores pushes to unrelated branches', async () => {
    const body = pushBody('hamidnoshady/nonexistent-theme-repo', 'develop')
    const res = await callWebhook(body)
    expect(res?.status).toBe(200)
    const json = await res?.json()
    expect(json.results?.[0]?.result).toBe('ref-mismatch')
  })

  it('deduplicates identical delivery ids', async () => {
    const delivery = 'duplicate-delivery-id-1'
    const body = pushBody('hamidnoshady/nonexistent-theme-repo', 'main')

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    )

    const first = await callWebhook(body, { 'x-github-delivery': delivery })
    expect(first?.status).toBe(200)

    await payload.update({
      collection: 'theme-packages',
      id: packageId,
      data: { githubLastDeliveryId: delivery },
      overrideAccess: true,
    })

    const second = await callWebhook(body, { 'x-github-delivery': delivery })
    const json = await second?.json()
    expect(json.results?.[0]?.result).toBe('duplicate')

    fetchSpy.mockRestore()
  })

  it('sync failure does not remove a prior manifest', async () => {
    await payload.update({
      collection: 'theme-packages',
      id: packageId,
      data: {
        contractVersion: 1,
        manifest: { key: 'kept' },
        manifestSyncedAt: new Date().toISOString(),
        syncedCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      overrideAccess: true,
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not found', { status: 404 }),
    )

    const syncRes = await themePackageSyncEndpoint.handler({
      ...adminReq,
      routeParams: { id: packageId },
      json: async () => ({}),
    } as PayloadRequest)
    expect(syncRes?.status).toBe(422)

    const row = await payload.findByID({
      collection: 'theme-packages',
      id: packageId,
      overrideAccess: true,
    })
    expect((row as { manifest?: { key?: string } }).manifest?.key).toBe('kept')

    fetchSpy.mockRestore()
  })
})
