// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cdnEndpoints } from '@/endpoints/cdn'

const handler = (path: string) => {
  const found = cdnEndpoints.find((c) => c.method === 'post' && c.path === path)
  if (!found?.handler) throw new Error(`Missing POST ${path} endpoint`)
  return found.handler
}

const siteDoc = { domain: 'example.com', domains: [], id: 'site-1' }
const acct = (enabled: boolean) => ({
  credentials: { apiToken: 'test-token' },
  enabled,
  id: 'acct-1',
  provider: 'arvancloud',
})

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/cdn/zones/connect', () => {
  it('creates a zone record referencing the remote zone without provisioning it', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'zone-1' })
    const findByID = vi.fn().mockResolvedValueOnce(acct(true)).mockResolvedValueOnce(siteDoc)
    const payload = {
      auth: vi.fn().mockResolvedValue({ user: { role: 'platformAdmin' } }),
      create,
      find: vi.fn().mockResolvedValue({ docs: [] }),
      findByID,
      logger: { error: vi.fn(), warn: vi.fn() },
    }
    const req = {
      context: {},
      data: { account: 'acct-1', remoteZoneId: 'zone-1', site: 'site-1', zoneName: 'example.com' },
      headers: {} as Headers,
      payload,
      query: {},
    }
    const response = await handler('/cdn/zones/connect')(req as never)
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, provider: 'arvancloud', state: 'queued', zoneName: 'example.com' })

    const createArgs = create.mock.calls[0][0] as { collection: string; data: Record<string, unknown> }
    expect(createArgs.collection).toBe('cdn-zones')
    expect(createArgs.data).toMatchObject({
      account: 'acct-1',
      managedBy: 'operator',
      providerZoneId: 'zone-1',
      provisionIfMissing: false,
      site: 'site-1',
      zoneName: 'example.com',
    })
  })

  it('refuses a zone name the site does not own', async () => {
    const findByID = vi.fn().mockResolvedValueOnce(acct(true)).mockResolvedValueOnce(siteDoc)
    const payload = {
      auth: vi.fn().mockResolvedValue({ user: { role: 'platformAdmin' } }),
      create: vi.fn().mockResolvedValue({}),
      find: vi.fn().mockResolvedValue({ docs: [] }),
      findByID,
      logger: { error: vi.fn(), warn: vi.fn() },
    }
    const req = {
      context: {},
      data: { account: 'acct-1', remoteZoneId: 'zone-1', site: 'site-1', zoneName: 'victim.com' },
      headers: {} as Headers,
      payload,
      query: {},
    }
    const response = await handler('/cdn/zones/connect')(req as never)
    expect(response.status).toBe(403)
  })

  it('refuses a disabled account', async () => {
    const findByID = vi.fn().mockResolvedValueOnce(acct(false))
    const payload = {
      auth: vi.fn().mockResolvedValue({ user: { role: 'platformAdmin' } }),
      create: vi.fn().mockResolvedValue({}),
      find: vi.fn().mockResolvedValue({ docs: [] }),
      findByID,
      logger: { error: vi.fn(), warn: vi.fn() },
    }
    const req = {
      context: {},
      data: { account: 'acct-1', remoteZoneId: 'zone-1', site: 'site-1', zoneName: 'example.com' },
      headers: {} as Headers,
      payload,
      query: {},
    }
    const response = await handler('/cdn/zones/connect')(req as never)
    expect(response.status).toBe(409)
  })
})
