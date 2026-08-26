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
  it('authorizes only an active, verified site returned by Payload', async () => {
    const { req, find } = request('client.example.com', [{ id: '1' }])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    // The security property lives in this filter: exact domain AND active AND
    // verified. Removing any clause must fail this test.
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'sites',
        where: {
          and: [
            { domain: { equals: 'client.example.com' } },
            { status: { equals: 'active' } },
            { domainVerified: { equals: true } },
          ],
        },
      }),
    )
  })

  it('normalizes a trailing dot and uppercase before querying', async () => {
    const { req, find } = request('Client.Example.Com.', [{ id: '1' }])
    const response = await domainCheck.handler!(req as never)
    expect(response.status).toBe(200)
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          and: expect.arrayContaining([{ domain: { equals: 'client.example.com' } }]),
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

  it.each(['', 'localhost', 'http://client.example.com', 'bad_domain.example.com'])(
    'refuses malformed host %s without querying the database',
    async (domain) => {
      const { req, find } = request(domain, [{ id: '1' }])
      const response = await domainCheck.handler!(req as never)
      expect(response.status).toBe(404)
      expect(find).not.toHaveBeenCalled()
    },
  )
})
