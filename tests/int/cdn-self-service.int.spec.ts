// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestApiKey } = vi.hoisted(() => ({ requestApiKey: vi.fn() }))
vi.mock('@/access/siteApiKey', () => ({ requestApiKey }))

import { encryptCdnSecret } from '@/cdn/crypto'
import { withCdnCredentials } from '@/cdn/resolve'
import {
  assertZoneBelongsToSite,
  mergeTenantRecords,
  parseTenantRecords,
  templateRecords,
  TenantCdnRefusal,
  type ZoneRecord,
} from '@/cdn/tenant'
import { CdnAccounts } from '@/collections/CdnAccounts'
import { assertCdnAccountUsable, originRecordType } from '@/collections/hooks/cdnAccountSecrets'
import { CDN_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/cdnZoneSecrets'
import { cdnEndpoints } from '@/endpoints/cdn'

process.env.CDN_INTEGRATIONS_KEY ??= 'this-is-a-dedicated-test-key-with-at-least-32-characters'

const site = {
  domain: 'acme.ir',
  domains: [{ hostname: 'www.acme.ir', verified: true }],
  id: 'site-acme',
  name: 'Acme',
}

const refusalStatus = (run: () => unknown): number | null => {
  try {
    run()
    return null
  } catch (error) {
    if (error instanceof TenantCdnRefusal) return error.status
    throw error
  }
}

describe('which zone a site may put behind the shared account', () => {
  it('accepts the site’s own hostname and the immediate parent of one', () => {
    expect(assertZoneBelongsToSite(site, 'ACME.ir.', [])).toBe('acme.ir')
    const shop = { ...site, domain: 'shop.acme.ir', domains: [] }
    expect(assertZoneBelongsToSite(shop, 'acme.ir', [])).toBe('acme.ir')
  })

  it('refuses a domain the site does not hold, and any broader parent', () => {
    expect(refusalStatus(() => assertZoneBelongsToSite(site, 'victim.ir', []))).toBe(403)
    const deep = { ...site, domain: 'a.b.acme.ir', domains: [] }
    expect(refusalStatus(() => assertZoneBelongsToSite(deep, 'acme.ir', []))).toBe(403)
    expect(refusalStatus(() => assertZoneBelongsToSite(site, 'ir', []))).toBe(400)
  })

  it('refuses a zone that would contain another customer’s hostname', () => {
    // `acme.ir` as a zone would let this tenant rewrite `blog.acme.ir`'s DNS.
    expect(refusalStatus(() => assertZoneBelongsToSite(site, 'acme.ir', ['blog.acme.ir']))).toBe(
      409,
    )
    // A look-alike outside the zone is not a conflict.
    expect(assertZoneBelongsToSite(site, 'acme.ir', ['notacme.ir'])).toBe('acme.ir')
  })
})

describe('records', () => {
  const platform = templateRecords(site, 'acme.ir', '185.10.0.1')

  it('the platform template proxies exactly this site’s hostnames to the operator origin', () => {
    expect(platform).toEqual([
      { content: '185.10.0.1', name: '@', proxied: true, source: 'platform', ttl: 1, type: 'A' },
      { content: '185.10.0.1', name: 'www', proxied: true, source: 'platform', ttl: 1, type: 'A' },
    ])
    expect(originRecordType('origin.eshobe.ir')).toBe('CNAME')
    expect(originRecordType('2001:db8::1')).toBe('AAAA')
  })

  it('makes every tenant row DNS-only, whatever was asked', () => {
    const [row] = parseTenantRecords(
      [{ content: '1.2.3.4', name: 'mail', proxied: true, type: 'A' }],
      'acme.ir',
      platform,
    )
    // Proxying a tenant-chosen origin would route a third party through the
    // operator's CDN account.
    expect(row).toMatchObject({ name: 'mail', proxied: false, source: 'tenant' })
  })

  it('refuses to shadow a platform record or to write junk', () => {
    expect(
      refusalStatus(() =>
        parseTenantRecords(
          [{ content: 'evil.example', name: 'www', type: 'CNAME' }],
          'acme.ir',
          platform,
        ),
      ),
    ).toBe(409)
    expect(
      refusalStatus(() =>
        parseTenantRecords(
          [{ content: '1.2.3.4', name: 'acme.ir', type: 'A' }],
          'acme.ir',
          platform,
        ),
      ),
    ).toBe(409)
    expect(
      refusalStatus(() =>
        parseTenantRecords([{ content: 'nope', name: 'x', type: 'A' }], 'acme.ir', platform),
      ),
    ).toBe(400)
    expect(
      refusalStatus(() =>
        parseTenantRecords([{ content: 'x', name: 'x', type: 'NS' }], 'acme.ir', platform),
      ),
    ).toBe(400)
  })

  it('updates in place by id, never adopts a platform row by id, and deletes only what it created', () => {
    const stored: ZoneRecord[] = [
      { ...platform[0]!, id: 'p1', providerRecordId: 'remote-p1' },
      {
        content: 'mx.mail.ir',
        id: 't1',
        name: '@mx',
        providerRecordId: 'remote-t1',
        source: 'tenant',
        type: 'MX',
      },
      {
        content: 'v=spf1 -all',
        id: 't2',
        name: 'spf',
        providerRecordId: 'remote-t2',
        source: 'tenant',
        type: 'TXT',
      },
    ]
    const { dnsRecords, removedProviderRecordIds } = mergeTenantRecords(stored, [
      { content: 'mx2.mail.ir', id: 't1', name: 'mx', source: 'tenant', type: 'MX' },
      // Claims the platform row's id: becomes a fresh row, the platform row is untouched.
      { content: 'hello', id: 'p1', name: 'txt', source: 'tenant', type: 'TXT' },
    ])
    expect(dnsRecords[0]).toEqual(stored[0])
    expect(dnsRecords[1]).toMatchObject({
      content: 'mx2.mail.ir',
      id: 't1',
      providerRecordId: 'remote-t1',
    })
    expect(dnsRecords[2]).not.toHaveProperty('id')
    expect(dnsRecords[2]).not.toHaveProperty('providerRecordId')
    expect(removedProviderRecordIds).toEqual(['remote-t2'])
  })
})

describe('the shared account', () => {
  const req = (account: unknown) => {
    const findByID = vi.fn(
      async ({ req: inner }: { req: { context: Record<string, unknown> } }) => {
        // The account's ciphertext is only ever read with the secret flag set.
        expect(inner.context[CDN_SECRET_READ_CONTEXT_KEY]).toBe(true)
        return account
      },
    )
    return { context: {} as Record<string, unknown>, payload: { findByID } }
  }

  it('is used when the zone has no token of its own, and the flag does not outlive the read', async () => {
    const token = encryptCdnSecret('shared-token')
    const r = req({
      cloudflareAccountId: 'acc-1',
      credentials: { apiToken: token },
      enabled: true,
      provider: 'cloudflare',
    })
    const zone = await withCdnCredentials(r as never, {
      account: 'a1',
      id: 'z1',
      provider: 'cloudflare',
      zoneName: 'acme.ir',
    })
    expect(zone.credentials?.apiToken).toBe(token)
    expect(zone.cloudflareAccountId).toBe('acc-1')
    expect(r.context[CDN_SECRET_READ_CONTEXT_KEY]).toBeUndefined()
  })

  it('never sends one provider’s token to the other, nor uses a disabled account', async () => {
    const token = encryptCdnSecret('shared-token')
    await expect(
      withCdnCredentials(
        req({ credentials: { apiToken: token }, enabled: true, provider: 'arvancloud' }) as never,
        {
          account: 'a1',
          provider: 'cloudflare',
          zoneName: 'acme.ir',
        },
      ),
    ).rejects.toThrow()
    await expect(
      withCdnCredentials(
        req({ credentials: { apiToken: token }, enabled: false, provider: 'cloudflare' }) as never,
        {
          account: 'a1',
          provider: 'cloudflare',
          zoneName: 'acme.ir',
        },
      ),
    ).rejects.toThrow()
  })

  it('prefers a zone’s own token over the account', async () => {
    const own = encryptCdnSecret('zone-token')
    const r = req(null)
    const zone = await withCdnCredentials(r as never, {
      account: 'a1',
      credentials: { apiToken: own },
      provider: 'cloudflare',
      zoneName: 'acme.ir',
    })
    expect(zone.credentials?.apiToken).toBe(own)
    expect(r.payload.findByID).not.toHaveBeenCalled()
  })

  it('is platform-admin only on every operation, and masks the token without the flag', async () => {
    const tenantReq = { context: {}, user: { role: 'user' } }
    for (const op of ['create', 'read', 'update', 'delete'] as const) {
      const access = CdnAccounts.access?.[op] as (args: unknown) => unknown
      expect(await access({ req: tenantReq }), op).toBe(false)
    }
    const credentials = CdnAccounts.fields.find((f) => 'name' in f && f.name === 'credentials') as {
      fields: Array<{ hooks?: { afterRead?: Array<(args: unknown) => unknown> } }>
    }
    const mask = credentials.fields[0]!.hooks!.afterRead![0]!
    expect(mask({ req: { context: {} }, value: 'enc:v1:secret' })).toBeUndefined()
  })

  it('refuses tenant self-service until the account can serve it', () => {
    const run = (data: Record<string, unknown>) => () =>
      assertCdnAccountUsable({ data, originalDoc: undefined } as never)
    const usable = {
      credentials: { apiToken: encryptCdnSecret('t') },
      originTarget: '185.10.0.1',
      provider: 'arvancloud',
      tenantSelfService: true,
    }
    expect(run(usable)).not.toThrow()
    expect(run({ ...usable, credentials: { apiToken: '' } })).toThrow()
    expect(run({ ...usable, originTarget: '' })).toThrow()
    // Arvan's template writes the apex, which cannot be a CNAME there.
    expect(run({ ...usable, originTarget: 'origin.eshobe.ir' })).toThrow()
    expect(run({ ...usable, provider: 'cloudflare' })).toThrow()
    expect(run({ ...usable, cloudflareAccountId: 'acc', provider: 'cloudflare' })).not.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

const endpoint = (method: string, path: string) => {
  const found = cdnEndpoints.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  if (!found?.handler) throw new Error(`Missing ${method} ${path}`)
  return found.handler
}

type Store = {
  accounts?: Array<Record<string, unknown>>
  body?: Record<string, unknown>
  otherSites?: Array<Record<string, unknown>>
  zone?: null | Record<string, unknown>
}

const request = (store: Store = {}) => {
  const find = vi.fn(async ({ collection }: { collection: string }) => {
    if (collection === 'cdn-accounts') return { docs: store.accounts ?? [] }
    if (collection === 'sites') return { docs: store.otherSites ?? [] }
    if (collection === 'cdn-zones') return { docs: store.zone ? [store.zone] : [] }
    return { docs: [] }
  })
  const payload = {
    auth: vi.fn().mockResolvedValue({ user: null }),
    create: vi.fn().mockResolvedValue({ id: 'zone-new' }),
    delete: vi.fn().mockResolvedValue({}),
    find,
    findByID: vi.fn().mockResolvedValue(site),
    logger: { error: vi.fn(), warn: vi.fn() },
    update: vi.fn().mockResolvedValue({}),
  }
  return {
    payload,
    req: { context: {}, data: store.body ?? {}, payload, query: {} },
  }
}

const arvan = { id: 'acct-arvan', originTarget: '185.10.0.1', provider: 'arvancloud' }

beforeEach(() => {
  requestApiKey.mockReset()
  requestApiKey.mockResolvedValue({ role: 'site', siteId: site.id })
})

describe('POST /site/cdn/zone', () => {
  it('refuses anything but that site’s own key, including a platform key', async () => {
    for (const key of [null, { role: 'platform', siteId: null }]) {
      requestApiKey.mockResolvedValue(key)
      const { payload, req } = request({ accounts: [arvan], body: { zoneName: 'acme.ir' } })
      const response = await endpoint('post', '/site/cdn/zone')(req as never)
      expect(response.status).toBe(403)
      expect(payload.create).not.toHaveBeenCalled()
    }
  })

  it('is off until the operator turns on self-service', async () => {
    const { payload, req } = request({ accounts: [], body: { zoneName: 'acme.ir' } })
    const response = await endpoint('post', '/site/cdn/zone')(req as never)
    expect(response.status).toBe(409)
    expect(payload.create).not.toHaveBeenCalled()
  })

  it('refuses another customer’s domain', async () => {
    const { payload, req } = request({ accounts: [arvan], body: { zoneName: 'victim.ir' } })
    const response = await endpoint('post', '/site/cdn/zone')(req as never)
    expect(response.status).toBe(403)
    expect(payload.create).not.toHaveBeenCalled()
  })

  it('creates the zone for the key’s site — never the body’s — on the shared account, queued', async () => {
    const { payload, req } = request({
      accounts: [arvan],
      body: { site: 'site-victim', zoneName: 'acme.ir', active: false, ssl: { mode: 'flexible' } },
    })
    const response = await endpoint('post', '/site/cdn/zone')(req as never)
    expect(response.status).toBe(202)
    const { data, overrideAccess } = payload.create.mock.calls[0]![0] as {
      data: Record<string, unknown>
      overrideAccess: boolean
    }
    expect(overrideAccess).toBe(true)
    expect(data).toMatchObject({
      account: 'acct-arvan',
      active: true,
      managedBy: 'tenant',
      provider: 'arvancloud',
      site: site.id,
      zoneName: 'acme.ir',
    })
    // Nothing else from the body reaches the row: TLS/WAF keep the safe defaults.
    expect(data).not.toHaveProperty('ssl')
    expect(data.syncRequestedAt).toEqual(expect.any(String))
    expect(
      (data.dnsRecords as ZoneRecord[]).every((r) => r.content === '185.10.0.1' && r.proxied),
    ).toBe(true)
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain('acct-arvan')
  })

  it('refuses a second zone for the same site', async () => {
    const { payload, req } = request({
      accounts: [arvan],
      body: { zoneName: 'acme.ir' },
      zone: { id: 'z1', managedBy: 'tenant', zoneName: 'acme.ir' },
    })
    expect((await endpoint('post', '/site/cdn/zone')(req as never)).status).toBe(409)
    expect(payload.create).not.toHaveBeenCalled()
  })
})

describe('tenant writes on an existing zone', () => {
  const tenantZone = {
    dnsRecords: [
      { content: '185.10.0.1', id: 'p1', name: '@', proxied: true, source: 'platform', type: 'A' },
    ],
    id: 'z1',
    managedBy: 'tenant',
    zoneName: 'acme.ir',
  }

  it('scopes every lookup to the key’s site and never to an id in the body', async () => {
    const { payload, req } = request({
      body: { id: 'someone-elses-zone', records: [] },
      zone: tenantZone,
    })
    const response = await endpoint('put', '/site/cdn/records')(req as never)
    expect(response.status).toBe(202)
    expect(payload.find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'cdn-zones', where: { site: { equals: site.id } } }),
    )
    expect(payload.update.mock.calls[0]![0]).toMatchObject({ id: 'z1' })
  })

  it('leaves an operator-managed zone alone', async () => {
    for (const [method, path] of [
      ['put', '/site/cdn/records'],
      ['post', '/site/cdn/sync'],
      ['delete', '/site/cdn/zone'],
    ] as const) {
      const { payload, req } = request({
        body: { records: [] },
        zone: { ...tenantZone, managedBy: 'platform' },
      })
      expect((await endpoint(method, path)(req as never)).status, path).toBe(409)
      expect(payload.update).not.toHaveBeenCalled()
      expect(payload.delete).not.toHaveBeenCalled()
    }
  })

  it('rate-limits a re-check', async () => {
    const { payload, req } = request({
      zone: { ...tenantZone, lastSyncAt: new Date().toISOString() },
    })
    expect((await endpoint('post', '/site/cdn/sync')(req as never)).status).toBe(429)
    expect(payload.update).not.toHaveBeenCalled()
  })

  it('detaches without calling the provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { payload, req } = request({ zone: tenantZone })
    expect((await endpoint('delete', '/site/cdn/zone')(req as never)).status).toBe(200)
    expect(payload.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'z1' }))
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
