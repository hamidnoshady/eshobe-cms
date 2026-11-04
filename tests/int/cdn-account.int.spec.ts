// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cdnEndpoints } from '@/endpoints/cdn'

const handler = (path: string) => {
  const found = cdnEndpoints.find((c) => c.method === 'post' && c.path === path)
  if (!found?.handler) throw new Error(`Missing POST ${path} endpoint`)
  return found.handler
}

const arvanListFetch = () => {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/domains')) {
      return new Response(JSON.stringify([{ id: 'zone-a', name: 'alpha.example.com', status: 'active' }]), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { fetch }
}

const reqWith = (data: Record<string, unknown>, create?: ReturnType<typeof vi.fn>) => {
  const payload = {
    auth: vi.fn().mockResolvedValue({ user: { role: 'platformAdmin' } }),
    create: create ?? vi.fn().mockResolvedValue({ id: 'acct-1' }),
    logger: { error: vi.fn(), warn: vi.fn() },
  }
  return { context: {}, data, headers: {} as Headers, payload, query: {} }
}

afterEach(() => vi.unstubAllGlobals())

describe('POST /api/cdn/accounts/test', () => {
  it('validates credentials and lists the account’s zones', async () => {
    const { fetch } = arvanListFetch()
    vi.stubGlobal('fetch', fetch)
    const req = reqWith({ apiToken: 'test-token', provider: 'arvancloud' })
    const response = await handler('/cdn/accounts/test')(req as never)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('arvancloud')
    expect(body.zones).toEqual([{ id: 'zone-a', status: 'active', zoneName: 'alpha.example.com' }])
  })

  it('rejects an unusable token with 409', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const req = reqWith({ apiToken: 'bad-token', provider: 'arvancloud' })
    const response = await handler('/cdn/accounts/test')(req as never)
    expect(response.status).toBe(409)
  })
})

describe('POST /api/cdn/accounts', () => {
  it('creates an account with the token encrypted on save', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'acct-1' })
    const req = reqWith({ apiToken: 'test-token', name: 'Arvan', provider: 'arvancloud' }, create)
    const response = await handler('/cdn/accounts')(req as never)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ ok: true, id: 'acct-1', provider: 'arvancloud', state: 'created' })

    const createArgs = create.mock.calls[0][0] as { collection: string; data: Record<string, unknown> }
    expect(createArgs.collection).toBe('cdn-accounts')
    expect(createArgs.data).toMatchObject({
      credentials: { apiToken: 'test-token' },
      enabled: true,
      name: 'Arvan',
      provider: 'arvancloud',
      tenantSelfService: false,
    })
  })
})
