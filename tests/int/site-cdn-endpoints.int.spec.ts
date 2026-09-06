import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestApiKey } = vi.hoisted(() => ({ requestApiKey: vi.fn() }))
vi.mock('@/access/siteApiKey', () => ({ requestApiKey }))

import { cdnEndpoints } from '@/endpoints/cdn'

const site = { id: 'site-acme', name: 'Acme' }

const endpoint = (method: 'get' | 'post', path: string) => {
  const found = cdnEndpoints.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  if (!found?.handler) throw new Error(`Missing ${method.toUpperCase()} ${path} endpoint`)
  return found.handler
}

const request = (zoneDocs: unknown[] = []) => {
  const find = vi.fn().mockResolvedValue({ docs: zoneDocs })
  const findByID = vi.fn().mockResolvedValue(site)
  const auth = vi.fn().mockResolvedValue({ user: null })
  return {
    find,
    req: {
      context: {},
      payload: { auth, create: vi.fn(), find, findByID, logger: { error: vi.fn(), warn: vi.fn() }, update: vi.fn() },
      query: {},
    },
  }
}

beforeEach(() => {
  requestApiKey.mockReset()
  requestApiKey.mockResolvedValue({ role: 'site', siteId: site.id })
})

describe('site-scoped CDN endpoints', () => {
  it('refuses a caller without that site’s own key', async () => {
    requestApiKey.mockResolvedValue(null)
    const { req } = request()
    const response = await endpoint('get', '/site/cdn')(req as never)
    expect(response.status).toBe(403)
  })

  it('refuses a platform key: a zone belongs to one tenant, and only that tenant reads it', async () => {
    requestApiKey.mockResolvedValue({ role: 'platform', siteId: null })
    const { req } = request()
    const response = await endpoint('get', '/site/cdn')(req as never)
    expect(response.status).toBe(403)
  })

  it('answers “not configured” rather than an error when the site has no zone', async () => {
    // The wizard's CDN step is *asking* this question; a 404 would read as a
    // broken call rather than as the answer.
    const { req } = request([])
    const response = await endpoint('get', '/site/cdn')(req as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ configured: false, provider: null })
  })

  it('scopes the read to the key’s own site and returns no credential', async () => {
    const { find, req } = request([
      {
        active: true,
        credentials: { apiToken: 'enc:v1:should-never-appear' },
        dnsRecords: [{ content: '185.10.0.1', name: 'acme.ir', proxied: true, type: 'A' }],
        lastSyncAt: '2026-09-01T00:00:00.000Z',
        lastSyncOk: true,
        provider: 'arvancloud',
        providerNameservers: [{ hostname: 'ns1.arvancdn.ir' }, { hostname: 'ns2.arvancdn.ir' }],
        providerStatus: 'active',
        site: site.id,
        zoneName: 'acme.ir',
      },
    ])

    const response = await endpoint('get', '/site/cdn')(req as never)
    expect(response.status).toBe(200)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { site: { equals: site.id } } }),
    )

    const body = await response.json()
    expect(body).toMatchObject({
      active: true,
      configured: true,
      nameservers: ['ns1.arvancdn.ir', 'ns2.arvancdn.ir'],
      provider: 'arvancloud',
      zoneName: 'acme.ir',
    })
    expect(body.records).toEqual([
      { content: '185.10.0.1', name: 'acme.ir', proxied: true, type: 'A' },
    ])
    // Three layers protect the token elsewhere; this endpoint must not be the
    // hole that makes them moot.
    expect(JSON.stringify(body)).not.toContain('should-never-appear')
  })

  it('refuses to purge a zone the platform has not switched on', async () => {
    const { req } = request([{ active: false, id: 'zone-1', provider: 'arvancloud', zoneName: 'acme.ir' }])
    const response = await endpoint('post', '/site/cdn/purge')(req as never)
    expect(response.status).toBe(409)
  })

  it('keeps zone creation and DNS/WAF writes off the tenant surface entirely', () => {
    // Purge is the only CDN write a tenant gets: it drops cached copies of that
    // site's own pages and touches nothing at the provider's DNS or firewall.
    const tenantPaths = cdnEndpoints
      .filter((candidate) => candidate.path.startsWith('/site/'))
      .map((candidate) => `${candidate.method} ${candidate.path}`)
    expect(tenantPaths.sort()).toEqual(['get /site/cdn', 'post /site/cdn/purge'])
  })
})
