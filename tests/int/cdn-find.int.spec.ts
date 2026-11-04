// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cdnEndpoints } from '@/endpoints/cdn'
import { listRemoteZones } from '@/cdn/service'
import type { CdnZoneInput } from '@/cdn/types'

const baseZone = (overrides: Partial<CdnZoneInput> = {}): CdnZoneInput => ({
  active: true,
  arvan: {},
  credentials: { apiToken: 'test-token' },
  dnsRecords: [],
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'arvancloud',
  zoneName: 'example.com',
  ...overrides,
})

/** ArvanCloud fetch mock: GET /domains returns two zones. */
const arvanListFetch = () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/domains')) {
      return new Response(
        JSON.stringify([
          { id: 'zone-b', name: 'beta.example.com', status: 'active' },
          { id: 'zone-a', name: 'alpha.example.com', status: 'pending' },
        ]),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { fetch }
}

const endpoint = (method: 'post', path: string) => {
  const found = cdnEndpoints.find((c) => c.method === method && c.path === path)
  if (!found?.handler) throw new Error(`Missing ${method.toUpperCase()} ${path} endpoint`)
  return found.handler
}

const buildReq = (account: Record<string, unknown>) => {
  const findByID = vi.fn().mockResolvedValue(account)
  const payload = {
    auth: vi.fn().mockResolvedValue({ user: { role: 'platformAdmin' } }),
    findByID,
    logger: { error: vi.fn(), warn: vi.fn() },
  }
  return {
    context: {},
    data: { account: 'acct-1' },
    headers: {} as Headers,
    payload,
    query: {},
    req: {
      context: {},
      data: { account: 'acct-1' },
      headers: {} as Headers,
      payload,
      query: {},
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('listRemoteZones', () => {
  it('lists ArvanCloud domains with id/name/status, sorted by name', async () => {
    const { fetch } = arvanListFetch()
    vi.stubGlobal('fetch', fetch)
    const zones = await listRemoteZones(baseZone())
    expect(zones).toEqual([
      { id: 'zone-a', status: 'pending', zoneName: 'alpha.example.com' },
      { id: 'zone-b', status: 'active', zoneName: 'beta.example.com' },
    ])
  })
})

describe('POST /api/cdn/zones/find', () => {
  it('lists the account’s remote zones without exposing credentials', async () => {
    const { fetch } = arvanListFetch()
    vi.stubGlobal('fetch', fetch)
    const { req } = buildReq({
      credentials: { apiToken: 'super-secret-token' },
      enabled: true,
      id: 'acct-1',
      provider: 'arvancloud',
    })

    const response = await endpoint('post', '/cdn/zones/find')(req as never)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('arvancloud')
    expect(body.zones).toEqual([
      { id: 'zone-a', status: 'pending', zoneName: 'alpha.example.com' },
      { id: 'zone-b', status: 'active', zoneName: 'beta.example.com' },
    ])
    // The token never appears in the response.
    expect(JSON.stringify(body)).not.toContain('super-secret-token')
  })

  it('refuses a disabled account', async () => {
    const { req } = buildReq({
      enabled: false,
      id: 'acct-1',
      provider: 'arvancloud',
    })
    const response = await endpoint('post', '/cdn/zones/find')(req as never)
    expect(response.status).toBe(409)
  })
})
