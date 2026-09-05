import { afterEach, describe, expect, it, vi } from 'vitest'

import { domainCheck } from '@/endpoints/domainCheck'

const request = (domain: string, docs: unknown[]) => {
  const find = vi.fn().mockResolvedValue({ docs })
  return { req: { query: { domain }, payload: { find } }, find }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Caddy domain authorization', () => {
  it('authorizes only an active, verified primary hostname returned by Payload', async () => {
    const { req, find } = request('client.example.com', [
      { domain: 'client.example.com', domainVerified: true, id: '1' },
    ])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    // The security property lives in the exact post-query match: a candidate row
    // alone does not authorise a hostname, it has to be active and verified too.
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'sites',
        where: {
          and: [
            { status: { equals: 'active' } },
            {
              or: [
                { domain: { equals: 'client.example.com' } },
                { 'domains.hostname': { equals: 'client.example.com' } },
              ],
            },
          ],
        },
      }),
    )
  })

  it('authorizes a verified alias but rejects a pending alias on the same site', async () => {
    const { req } = request('www.client.example.com', [
      {
        domain: 'client.example.com',
        domainVerified: true,
        domains: [
          { hostname: 'www.client.example.com', verified: true },
          { hostname: 'pending.client.example.com', verified: false },
        ],
        id: '1',
      },
    ])
    expect((await domainCheck.handler!(req as never)).status).toBe(200)

    const pending = request('pending.client.example.com', [
      {
        domain: 'client.example.com',
        domainVerified: true,
        domains: [{ hostname: 'pending.client.example.com', verified: false }],
        id: '1',
      },
    ])
    expect((await domainCheck.handler!(pending.req as never)).status).toBe(404)
  })

  it('does not let a database join mix one alias hostname with another alias verification', async () => {
    // A SQL query through an array can match hostname on row A and `verified` on
    // row B. The endpoint must inspect the precise matched row afterwards.
    const { req } = request('pending.client.example.com', [
      {
        domain: 'client.example.com',
        domains: [
          { hostname: 'pending.client.example.com', verified: false },
          { hostname: 'www.client.example.com', verified: true },
        ],
        id: '1',
      },
    ])

    expect((await domainCheck.handler!(req as never)).status).toBe(404)
  })

  it('normalizes a trailing dot and uppercase before querying', async () => {
    const { req, find } = request('Client.Example.Com.', [
      { domain: 'client.example.com', domainVerified: true, id: '1' },
    ])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(200)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          and: expect.arrayContaining([
            expect.objectContaining({
              or: expect.arrayContaining([{ domain: { equals: 'client.example.com' } }]),
            }),
          ]),
        }),
      }),
    )
  })

  it('refuses when no verified site matches', async () => {
    const { req } = request('unknown.example.com', [])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses the control-plane host without querying the database', async () => {
    vi.stubEnv('NEXT_PUBLIC_SERVER_URL', 'https://admin.example.com')
    const { req, find } = request('admin.example.com', [{ id: '1' }])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(404)
    expect(find).not.toHaveBeenCalled()
  })

  it.each([
    '',
    'localhost',
    'http://client.example.com',
    'bad_domain.example.com',
    'client.localhost',
  ])('refuses malformed or development host %s without querying the database', async (domain) => {
    const { req, find } = request(domain, [{ id: '1' }])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(404)
    expect(find).not.toHaveBeenCalled()
  })
})
