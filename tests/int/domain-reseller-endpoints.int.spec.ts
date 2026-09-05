import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestApiKey } = vi.hoisted(() => ({ requestApiKey: vi.fn() }))
vi.mock('@/access/siteApiKey', () => ({ requestApiKey }))

import { domainResellerEndpoints } from '@/endpoints/domainReseller'

const site = { id: 'site-acme', name: 'Acme' }
const foreignSite = 'site-other'

const endpoint = (method: 'get' | 'post', path: string) => {
  const found = domainResellerEndpoints.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  if (!found?.handler) throw new Error(`Missing ${method.toUpperCase()} ${path} endpoint`)
  return found.handler
}

const request = ({
  domainDocs = [],
  productDocs = [],
  query = {},
}: {
  domainDocs?: unknown[]
  productDocs?: unknown[]
  query?: Record<string, unknown>
} = {}) => {
  const find = vi
    .fn()
    .mockResolvedValueOnce({ docs: productDocs })
    .mockResolvedValueOnce({ docs: domainDocs })
  const findByID = vi.fn().mockResolvedValue(site)
  const findGlobal = vi.fn().mockResolvedValue({
    enabled: true,
    margins: { registrationPercent: 10, renewalPercent: 20, transferPercent: 15 },
  })

  return {
    find,
    req: {
      context: {},
      payload: { find, findByID, findGlobal, logger: { error: vi.fn() } },
      query,
    },
  }
}

beforeEach(() => {
  requestApiKey.mockReset()
  requestApiKey.mockResolvedValue({ role: 'site', siteId: site.id })
})

describe('domain reseller tenant endpoints', () => {
  it('does not report another tenant’s in-flight domain as globally available or reveal its owner', async () => {
    const { req } = request({
      domainDocs: [
        { domain: 'example.ir', id: 'domain-foreign', site: foreignSite, state: 'requested' },
      ],
      productDocs: [
        {
          currency: 'IRT',
          enabled: true,
          id: 'product-ir',
          registrationCost: 100_000,
          renewalCost: 90_000,
          tld: 'ir',
          transferCost: 80_000,
        },
      ],
      query: { domain: 'example.ir', operation: 'register', period: '1' },
    })

    const response = await endpoint('get', '/site/registrar/quote')(req as never)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      availability: 'reservedInPlatform',
      quote: { marginPercentage: 10, price: 110_000 },
    })
    expect(body).not.toHaveProperty('site')
  })

  it('refuses management of a domain assigned to another site before it can call the registrar', async () => {
    const findByID = vi
      .fn()
      .mockResolvedValueOnce(site)
      .mockResolvedValueOnce({
        domain: 'foreign.ir',
        id: 'domain-foreign',
        site: foreignSite,
        state: 'active',
      })
    const req = {
      context: {},
      json: async () => ({ action: 'lock.get', id: '00000000-0000-4000-8000-000000000099' }),
      payload: { findByID, logger: { error: vi.fn() } },
      query: {},
    }

    const response = await endpoint('post', '/site/registrar/manage')(req as never)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ ok: false })
  })

  it('scopes the domain list by the site derived from the API key, never a caller-supplied site', async () => {
    const find = vi.fn().mockResolvedValue({
      docs: [
        {
          domain: 'acme.ir',
          id: 'domain-acme',
          nameservers: [{ hostname: 'ns1.acme.ir' }],
          site: site.id,
          state: 'providerAccepted',
          tld: 'ir',
        },
      ],
    })
    const findByID = vi.fn().mockResolvedValue(site)
    const req = {
      context: {},
      payload: { find, findByID, logger: { error: vi.fn() } },
      query: { site: foreignSite },
    }

    const response = await endpoint('get', '/site/registrar/domains')(req as never)
    expect(response.status).toBe(200)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { site: { equals: site.id } } }),
    )
    await expect(response.json()).resolves.toEqual({
      domains: [
        {
          domain: 'acme.ir',
          id: 'domain-acme',
          nameservers: ['ns1.acme.ir'],
          state: 'providerAccepted',
          tld: 'ir',
        },
      ],
    })
  })
})
