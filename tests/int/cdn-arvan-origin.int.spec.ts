// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  arvanStrictVerifiable,
  arvanUpstreamHttps,
  discoverCdnZone,
  syncCdnZone,
  testCdnConnection,
} from '@/cdn/service'
import type { CdnZoneInput } from '@/cdn/types'

const baseZone = (overrides: Partial<CdnZoneInput> = {}): CdnZoneInput => ({
  active: true,
  arvan: {},
  credentials: { apiToken: 'test-token' },
  dnsRecords: [{ content: '203.0.113.10', name: '@', proxied: true, type: 'A' }],
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'arvancloud',
  ssl: { mode: 'strict' },
  zoneName: 'example.com',
  ...overrides,
})

/** A fetch mock that records every call and routes ArvanCloud responses by
 * method + path. `sslBody` / `cachingBody` are returned for the PATCH reads. */
const arvanFetch = (options: { sslBody?: unknown; cachingBody?: unknown } = {}) => {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })

    const ssl = '/ssl'
    const caching = '/caching'
    if (method === 'GET' && url.endsWith('/dns-records'))
      return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/domains/') && !url.includes('/dns-records'))
      return new Response(
        JSON.stringify({ status: 'active', name_servers: ['ns1.arvancloud.ir', 'ns2.arvancloud.ir'] }),
        { status: 200 },
      )
    if (method === 'POST' && url.endsWith('/dns-records'))
      return new Response(JSON.stringify({ id: 'rec-1' }), { status: 200 })
    if (method === 'PUT' && url.endsWith('/cloud'))
      return new Response(JSON.stringify({}), { status: 200 })
    if (method === 'PATCH' && url.endsWith(ssl))
      return new Response(JSON.stringify(options.sslBody ?? {}), { status: 200 })
    if (method === 'PATCH' && url.endsWith(caching))
      return new Response(JSON.stringify(options.cachingBody ?? {}), { status: 200 })
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { calls, fetch }
}

afterEach(() => vi.unstubAllGlobals())

describe('ArvanCloud origin TLS mapping', () => {
  it('maps ssl.mode onto upstream_https and never claims strict validation', () => {
    expect(arvanUpstreamHttps({ ...baseZone(), ssl: { mode: 'flexible' } })).toBe('off')
    expect(arvanUpstreamHttps({ ...baseZone(), ssl: { mode: 'full' } })).toBe('on')
    expect(arvanUpstreamHttps({ ...baseZone(), ssl: { mode: 'strict' } })).toBe('on')
    expect(arvanUpstreamHttps({ ...baseZone(), ssl: undefined })).toBe('default')
    // An explicit ArvanCloud control wins over the generic ssl.mode.
    expect(arvanUpstreamHttps({ ...baseZone(), arvan: { originHttps: 'off' }, ssl: { mode: 'strict' } })).toBe('off')
    // ArvanCloud cannot enforce strict certificate validation.
    expect(arvanStrictVerifiable({ ...baseZone(), ssl: { mode: 'strict' } })).toBe(false)
    expect(arvanStrictVerifiable({ ...baseZone(), ssl: { mode: 'full' } })).toBe(true)
  })

  it('sends the record-level upstream_https and an explicit origin-port', async () => {
    const { calls, fetch } = arvanFetch()
    vi.stubGlobal('fetch', fetch)

    await syncCdnZone(
      baseZone({
        arvan: { originHttps: 'on', originPort: 8443 },
        ssl: { mode: 'strict' },
      }),
    )

    const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/dns-records'))
    expect(create?.body).toMatchObject({
      type: 'A',
      cloud: true,
      upstream_https: 'on',
      value: [{ country: '', ip: '203.0.113.10', port: 8443, weight: null }],
    })
  })

  it("normalises the edge minimum TLS to ArvanCloud's TLSv form and records the mapping", async () => {
    const { calls, fetch } = arvanFetch()
    vi.stubGlobal('fetch', fetch)

    const result = await syncCdnZone(baseZone({ ssl: { mode: 'strict', minimumTls: '1.2' } }))

    const ssl = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/ssl'))
    expect(ssl?.body).toMatchObject({ tls_version: 'TLSv1.2' })
    expect(result.actions).toContainEqual(
      expect.objectContaining({
        name: 'origin-tls-mode',
        state: 'applied',
        detail: expect.stringContaining('upstream_https=on'),
      }),
    )
  })

  it('reports strict as not verifiable in the mapping detail', async () => {
    const { fetch } = arvanFetch()
    vi.stubGlobal('fetch', fetch)
    const result = await syncCdnZone(baseZone({ ssl: { mode: 'strict' } }))
    const mapping = result.actions.find((action) => action.name === 'origin-tls-mode')
    expect(mapping?.detail).toContain('upstream_https=on')
    expect(mapping?.detail).toMatch(/بررسی نمی‌شود/)
  })
})

describe('read-only discovery', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads ArvanCloud remote state without mutating anything', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url })
        if (String(url).endsWith('/dns-records'))
          return new Response(
            JSON.stringify([
              {
                cloud: true,
                id: 'r1',
                name: '@',
                type: 'A',
                ttl: 120,
                upstream_https: 'on',
                value: [{ country: '', ip: '203.0.113.10', port: null, weight: null }],
              },
            ]),
            { status: 200 },
          )
        if (String(url).endsWith('/ssl'))
          return new Response(
            JSON.stringify({ hsts_status: true, tls_version: 'TLSv1.2', https_redirect: true }),
            { status: 200 },
          )
        if (String(url).endsWith('/caching'))
          return new Response(JSON.stringify({ browser_cache_ttl: 3600 }), { status: 200 })
        return new Response(
          JSON.stringify({ status: 'active', name_servers: ['ns1', 'ns2'] }),
          { status: 200 },
        )
      }),
    )

    const result = await discoverCdnZone(baseZone({ active: false }))
    expect(result.remote.dnsRecords).toEqual([
      {
        content: '203.0.113.10',
        name: '@',
        proxied: true,
        providerRecordId: 'r1',
        ttl: 120,
        type: 'A',
      },
    ])
    expect(result.remote.settings.minimumTls).toBe('1.2')
    expect(result.remote.settings.hsts).toEqual({ enabled: true })
    // Discovery is read-only: no writes at the provider.
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/ssl'))).toBe(true)
    expect(calls.some((call) => call.url.endsWith('/caching'))).toBe(true)
  })

  it('reads Cloudflare remote state without mutating anything', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && String(url).includes('/dns_records'))
          return new Response(
            JSON.stringify({
              result: [
                { id: 'cf-r1', name: 'example.com', content: '203.0.113.10', type: 'A', proxied: true, ttl: 1 },
              ],
              success: true,
            }),
            { status: 200 },
          )
        if (method === 'GET' && String(url).includes('/zones?'))
          return new Response(
            JSON.stringify({
              result: [{ id: 'cf-zone', name: 'example.com', status: 'active', nameservers: ['ns1', 'ns2'] }],
              success: true,
            }),
            { status: 200 },
          )
        return new Response(JSON.stringify({ result: {}, success: true }), { status: 200 })
      }),
    )

    const result = await discoverCdnZone(
      baseZone({ provider: 'cloudflare', active: false, dnsRecords: [] }),
    )
    expect(result.remote.dnsRecords).toEqual([
      {
        content: '203.0.113.10',
        name: 'example.com',
        proxied: true,
        providerRecordId: 'cf-r1',
        ttl: null,
        type: 'A',
      },
    ])
    expect(result.remote.nameservers).toEqual(['ns1', 'ns2'])
  })
})

describe('connection test', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports success when the token can see the zone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ status: 'active', name_servers: ['ns1'] }), { status: 200 }),
      ),
    )
    const result = await testCdnConnection(baseZone({ active: false }))
    expect(result.ok).toBe(true)
    expect(result.message).toContain('اتصال برقرار است')
  })

  it('distinguishes a rejected token from a missing zone', async () => {
    // 401 from the provider → token rejected.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 })),
    )
    const rejected = await testCdnConnection(baseZone({ active: false }))
    expect(rejected.ok).toBe(false)
    expect(rejected.message).toMatch(/رد شد/)

    // The domain read 404s and creation is not allowed → the token authenticated
    // but the zone is not there. This is a different remedy than a bad token.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'not found' }), { status: 404 })),
    )
    const missing = await testCdnConnection(baseZone({ active: false }))
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('ArvanCloud')
  })
})
