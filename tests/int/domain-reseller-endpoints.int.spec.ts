import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestApiKey } = vi.hoisted(() => ({ requestApiKey: vi.fn() }))
vi.mock('@/access/siteApiKey', () => ({ requestApiKey }))

import { domainResellerEndpoints } from '@/endpoints/domainReseller'
import { resetRateLimits } from '@/lib/rate-limit'

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
  requestApiKey.mockResolvedValue({ id: 'key-acme', role: 'site', siteId: site.id })
  resetRateLimits()
  vi.unstubAllGlobals()
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
    const findByID = vi.fn().mockResolvedValueOnce(site).mockResolvedValueOnce({
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

  it('prices a domain for a platform key, so a site can be quoted before it exists', async () => {
    // The builder's site-building wizard asks "what does this domain cost?" at
    // its first step — before the site, and therefore its site key, exists.
    requestApiKey.mockResolvedValue({ role: 'platform', siteId: null })
    const { req } = request({
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
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      // No site in the request, so there is nothing for `managedHere` to mean.
      availability: 'unknown',
      quote: { price: 110_000 },
    })
  })

  it('still refuses to ORDER a domain on a platform key — pricing is widened, committing is not', async () => {
    requestApiKey.mockResolvedValue({ role: 'platform', siteId: null })
    const req = {
      context: {},
      json: async () => ({ domain: 'example.ir', operation: 'register', period: 1 }),
      payload: { find: vi.fn(), findByID: vi.fn(), logger: { error: vi.fn() } },
      query: {},
    }

    const response = await endpoint('post', '/site/registrar/domains')(req as never)
    expect(response.status).toBe(403)
  })
})

const productDoc = {
  currency: 'IRT',
  enabled: true,
  id: 'product-ir',
  registrationCost: 100_000,
  renewalCost: 90_000,
  tld: 'ir',
  transferCost: 80_000,
}

/** A request shaped for the search route: a configured, enabled reseller global plus
 * whatever the `reseller-domains` lookup should find. */
const searchRequest = ({
  domainDocs = [],
  productDocs = [productDoc],
  query = { domain: 'example.ir' },
}: {
  domainDocs?: unknown[]
  productDocs?: unknown[]
  query?: Record<string, unknown>
} = {}) => {
  const find = vi.fn(async ({ collection }: { collection: string }) =>
    collection === 'domain-reseller-products' ? { docs: productDocs } : { docs: domainDocs },
  )
  const findGlobal = vi.fn().mockResolvedValue({
    apiEndpoint: 'https://resellerarea.net/api',
    credentials: { apiKey: 'platform-only-secret' },
    enabled: true,
    margins: { registrationPercent: 10, renewalPercent: 20, transferPercent: 15 },
  })

  return {
    find,
    req: {
      context: {},
      headers: new Headers(),
      payload: {
        find,
        findByID: vi.fn().mockResolvedValue(site),
        findGlobal,
        logger: { error: vi.fn() },
      },
      query,
    },
  }
}

const providerReplies = (body: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  )

describe('domain search before buying', () => {
  it('reports a WHOIS-registered name as taken and offers transfer, not register', async () => {
    providerReplies({ result: { registrant: { first_name: 'Someone' } }, success: true })
    const { req } = searchRequest()

    const response = await endpoint('get', '/site/registrar/search')(req as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      availability: 'registered',
      checkedWithRegistrar: true,
      operations: ['transfer'],
      // Priced in the same round trip, so the UI never has to ask again per button.
      quotes: { transfer: { price: 92_000 } },
    })
  })

  it('reports a name the registry has no record of as available, and prices registration', async () => {
    providerReplies({ errors: [{ code: 404, message: 'Domain not found.' }], success: false })
    const { req } = searchRequest()

    const response = await endpoint('get', '/site/registrar/search')(req as never)
    await expect(response.json()).resolves.toMatchObject({
      availability: 'available',
      checkedWithRegistrar: true,
      operations: ['register'],
      quotes: { register: { price: 110_000 } },
    })
  })

  it('never sells a provider outage as an available domain', async () => {
    // A key/quota/network failure is not evidence about the name. The honest answer keeps
    // both actions open and lets the registrar decide, instead of taking money for a
    // RegisterDomain that will be rejected.
    providerReplies({ errors: [{ code: 401, message: 'Invalid API key' }], success: false })
    const { req } = searchRequest()

    const body = await (await endpoint('get', '/site/registrar/search')(req as never)).json()
    expect(body).toMatchObject({ availability: 'unknown', operations: ['register', 'transfer'] })
  })

  it('answers another tenant’s in-flight name locally, without a registrar call or an owner', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { req } = searchRequest({
      domainDocs: [
        {
          domain: 'example.ir',
          id: 'domain-foreign',
          site: foreignSite,
          state: 'providerAccepted',
        },
      ],
    })

    const body = await (await endpoint('get', '/site/registrar/search')(req as never)).json()
    expect(body).toMatchObject({ availability: 'reservedInPlatform', operations: [] })
    expect(body).not.toHaveProperty('site')
    // Not merely absent from the response: never asked, so the probe cannot be used to
    // time or confirm another tenant's domain either.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('offers renew only for this site’s own accepted domain', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { req } = searchRequest({
      domainDocs: [
        { domain: 'example.ir', id: 'domain-acme', site: site.id, state: 'providerAccepted' },
      ],
    })

    const body = await (await endpoint('get', '/site/registrar/search')(req as never)).json()
    expect(body).toMatchObject({
      availability: 'managedHere',
      operations: ['renew'],
      quotes: { renew: { price: 108_000 } },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throttles searches per credential so one tenant cannot burn the platform’s registrar quota', async () => {
    providerReplies({ errors: [{ message: 'Domain not found.' }], success: false })
    process.env.DOMAIN_SEARCH_RATE_LIMIT = '2'
    try {
      const run = async () => {
        const { req } = searchRequest()
        return endpoint('get', '/site/registrar/search')(req as never)
      }
      expect((await run()).status).toBe(200)
      expect((await run()).status).toBe(200)
      const limited = await run()
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBeTruthy()
    } finally {
      delete process.env.DOMAIN_SEARCH_RATE_LIMIT
    }
  })

  it('searches on a platform key, but cannot say managedHere without a site', async () => {
    requestApiKey.mockResolvedValue({ id: 'key-platform', role: 'platform', siteId: null })
    providerReplies({ errors: [{ message: 'Domain not found.' }], success: false })
    const { req } = searchRequest()

    const response = await endpoint('get', '/site/registrar/search')(req as never)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ availability: 'available' })
  })
})

describe('ordering refuses the request the search step exists to prevent', () => {
  const orderRequest = (body: Record<string, unknown>) => {
    const find = vi.fn(async ({ collection }: { collection: string }) =>
      collection === 'domain-reseller-products' ? { docs: [productDoc] } : { docs: [] },
    )
    return {
      context: {},
      headers: new Headers(),
      json: async () => body,
      payload: {
        create: vi.fn(),
        find,
        findByID: vi.fn().mockResolvedValue(site),
        findGlobal: vi.fn().mockResolvedValue({
          apiEndpoint: 'https://resellerarea.net/api',
          credentials: { apiKey: 'platform-only-secret' },
          enabled: true,
          margins: { registrationPercent: 10, renewalPercent: 20, transferPercent: 15 },
        }),
        logger: { error: vi.fn() },
        update: vi.fn(),
      },
      query: {},
    }
  }

  it('refuses to register a domain WHOIS proves is already registered, before any billable call', async () => {
    const commands: string[] = []
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      commands.push(JSON.parse(String(init?.body)).command)
      return new Response(
        JSON.stringify({ result: { registrant: { email: 'a@b.c' } }, success: true }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchSpy)
    const req = orderRequest({
      domain: 'example.ir',
      nameservers: ['ns1.example.net', 'ns2.example.net'],
      operation: 'register',
      period: 1,
    })

    const response = await endpoint('post', '/site/registrar/domains')(req as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ ok: false, operations: ['transfer'] })
    // Exactly one provider call: the WHOIS probe. RegisterDomain — the command that
    // spends the platform's reseller balance — was never sent.
    expect(commands).toEqual(['GetDomainWhoisInfo'])
    expect(req.payload.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'reseller-domain-operations' }),
    )
  })

  it('refuses to transfer a domain that is not registered at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ errors: [{ message: 'No match for domain' }], success: false }),
            {
              status: 200,
            },
          ),
      ),
    )
    const req = orderRequest({
      domain: 'example.ir',
      nameservers: ['ns1.example.net'],
      operation: 'transfer',
      period: 1,
    })

    const response = await endpoint('post', '/site/registrar/domains')(req as never)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ ok: false, operations: ['register'] })
  })
})
