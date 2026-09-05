import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestApiKey } = vi.hoisted(() => ({ requestApiKey: vi.fn() }))

vi.mock('@/access/siteApiKey', () => ({ requestApiKey }))

import { siteDomainsEndpoints } from '@/endpoints/siteDomains'

const site = {
  domain: 'acme.example.com',
  domainVerified: true,
  domains: [{ hostname: 'www.acme.example.com', id: 'www', verified: true }],
  id: 'site-acme',
}

const endpoint = (method: 'delete' | 'get' | 'post') => {
  const found = siteDomainsEndpoints.find((candidate) => candidate.method === method)
  if (!found?.handler) throw new Error(`Missing ${method.toUpperCase()} /site/domains endpoint`)
  return found.handler
}

const request = (body?: unknown, findDocs: unknown[] = []) => {
  const find = vi.fn().mockResolvedValue({ docs: findDocs })
  const findByID = vi.fn().mockResolvedValue(site)
  const update = vi.fn().mockImplementation(async ({ data }) => ({ ...site, ...data }))

  return {
    payload: { find, findByID, update },
    req: {
      json: async () => body,
      payload: { find, findByID, update },
    },
    update,
  }
}

beforeEach(() => {
  requestApiKey.mockReset()
  requestApiKey.mockResolvedValue({ role: 'site', siteId: site.id })
})

describe('tenant domain aliases API', () => {
  it('lists primary and aliases only to the authenticated site key', async () => {
    const { req } = request()
    const response = await endpoint('get')(req as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      aliases: [{ hostname: 'www.acme.example.com', verified: true }],
      primary: { hostname: 'acme.example.com', verified: true },
    })
  })

  it('creates a normalized pending alias; the tenant cannot self-verify it', async () => {
    const { req, update } = request({ hostname: ' Shop.Acme.Example.Com. ' })
    const response = await endpoint('post')(req as never)

    expect(response.status).toBe(201)
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          domains: [
            { hostname: 'www.acme.example.com', id: 'www', verified: true },
            { hostname: 'shop.acme.example.com', verified: false },
          ],
        },
      }),
    )
    await expect(response.json()).resolves.toMatchObject({
      aliases: expect.arrayContaining([{ hostname: 'shop.acme.example.com', verified: false }]),
    })
  })

  it('refuses a hostname that another tenant already owns', async () => {
    const foreign = { domain: 'other.example.com', domains: [], id: 'site-other' }
    const { req, update } = request({ hostname: 'other.example.com' }, [foreign])
    const response = await endpoint('post')(req as never)

    expect(response.status).toBe(409)
    expect(update).not.toHaveBeenCalled()
  })

  it('removes aliases but never treats the primary hostname as removable', async () => {
    const { req, update } = request({ hostname: 'www.acme.example.com' })
    const response = await endpoint('delete')(req as never)

    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { domains: [] } }))

    const primary = request({ hostname: 'acme.example.com' })
    const primaryResponse = await endpoint('delete')(primary.req as never)
    expect(primaryResponse.status).toBe(404)
    expect(primary.update).not.toHaveBeenCalled()
  })
})
