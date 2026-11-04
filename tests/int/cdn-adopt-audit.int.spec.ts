// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cdnEndpoints } from '@/endpoints/cdn'

const site = { id: 'site-acme', name: 'Acme' }
const zoneId = '00000000-0000-4000-8000-000000000001'

const endpoint = (method: 'post', path: string) => {
  const found = cdnEndpoints.find((c) => c.method === method && c.path === path)
  if (!found?.handler) throw new Error(`Missing ${method.toUpperCase()} ${path} endpoint`)
  return found.handler
}

/** ArvanCloud discovery fetch mock: returns one A record and one foreign MX. */
const arvanFetch = () => {
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    calls.push(url)
    if (url.endsWith('/dns-records')) {
      return new Response(
        JSON.stringify([
          { id: 'r1', name: 'example.com', type: 'A', value: [{ ip: '203.0.113.10' }], cloud: false, ttl: 3600 },
          {
            id: 'foreign-1',
            name: 'mail.example.com',
            type: 'MX',
            value: { host: 'mx.example.com' },
            cloud: false,
            ttl: 3600,
          },
        ]),
        { status: 200 },
      )
    }
    if (url.endsWith('/ssl')) return new Response(JSON.stringify({ hsts_status: false }), { status: 200 })
    if (url.endsWith('/caching')) return new Response(JSON.stringify({}), { status: 200 })
    if (url.includes('/domains/example.com')) {
      return new Response(
        JSON.stringify({ id: 'zone-1', status: 'active', name_servers: ['ns1.arvancloud.ir', 'ns2.arvancloud.ir'] }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { calls, fetch }
}

const buildReq = (update: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>) => {
  const findByID = vi.fn().mockResolvedValue({
    active: true,
    credentials: { apiToken: 'test-token' },
    dnsRecords: [{ content: '198.51.100.99', name: 'mail', proxied: false, type: 'MX' }],
    id: zoneId,
    provider: 'arvancloud',
    providerNameservers: [{ hostname: 'ns1.arvancloud.ir' }],
    site: site.id,
    zoneName: 'example.com',
  })
  const payload = {
    auth: vi.fn().mockResolvedValue({ user: { role: 'platformAdmin' } }),
    create,
    findByID,
    logger: { error: vi.fn(), warn: vi.fn() },
    update,
  }
  return {
    context: {},
    data: { id: zoneId, providerRecordIds: ['foreign-1'] },
    headers: {} as Headers,
    payload,
    query: {},
    req: {
      context: {},
      data: { id: zoneId, providerRecordIds: ['foreign-1'] },
      headers: {} as Headers,
      payload,
      query: {},
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/cdn/zones/adopt audit trail', () => {
  it('persists the adopted desired state and writes an adopt audit event', async () => {
    const { fetch } = arvanFetch()
    vi.stubGlobal('fetch', fetch)
    const update = vi.fn().mockResolvedValue({})
    const create = vi.fn().mockResolvedValue({ id: 'evt-1' })
    const { req } = buildReq(update, create)

    const response = await endpoint('post', '/cdn/zones/adopt')(req as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      adopted: [{ name: 'mail.example.com', providerRecordId: 'foreign-1', type: 'MX' }],
      ok: true,
      refused: [],
    })

    // The zone is updated so the adopted record is now CMS-managed.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'cdn-zones',
        data: expect.objectContaining({
          dnsRecords: expect.arrayContaining([
            expect.objectContaining({ name: 'mail', providerRecordId: 'foreign-1', type: 'MX' }),
          ]),
        }),
        id: zoneId,
      }),
    )

    // An audit event records what was adopted.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'cdn-events',
        data: expect.objectContaining({
          ok: true,
          operation: 'adopt',
          zone: zoneId,
        }),
      }),
    )
    const auditData = create.mock.calls[0][0].data as { summary: string }
    expect(auditData.summary).toContain('Adopted 1 remote record(s)')
    expect(auditData.summary).toContain('MX mail.example.com')
  })
})
