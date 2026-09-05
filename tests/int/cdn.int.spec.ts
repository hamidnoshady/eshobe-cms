import { afterEach, describe, expect, it, vi } from 'vitest'

import { decryptCdnSecret, encryptCdnSecret } from '@/cdn/crypto'
import { CdnConfigurationError, syncCdnZone } from '@/cdn/service'
import type { CdnZoneInput } from '@/cdn/types'

const baseZone = (overrides: Partial<CdnZoneInput> = {}): CdnZoneInput => ({
  active: false,
  credentials: { apiToken: 'test-token' },
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'cloudflare',
  zoneName: 'example.com',
  ...overrides,
})

describe('CDN secret and reconciliation boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses authenticated encryption and returns null for a tampered token', () => {
    const previous = process.env.CDN_INTEGRATIONS_KEY
    process.env.CDN_INTEGRATIONS_KEY = 'this-is-a-dedicated-test-key-with-at-least-32-characters'
    try {
      const encrypted = encryptCdnSecret('cloudflare-secret')
      expect(encrypted).not.toContain('cloudflare-secret')
      expect(decryptCdnSecret(encrypted)).toBe('cloudflare-secret')
      const last = encrypted.at(-1)
      expect(decryptCdnSecret(`${encrypted.slice(0, -1)}${last === 'x' ? 'y' : 'x'}`)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CDN_INTEGRATIONS_KEY
      else process.env.CDN_INTEGRATIONS_KEY = previous
    }
  })

  it('only probes an inactive zone and never writes provider state', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url })
        return new Response(
          JSON.stringify({
            result: [{ id: 'zone-1', name: 'example.com', status: 'active' }],
            success: true,
          }),
          { status: 200 },
        )
      }),
    )

    const result = await syncCdnZone(baseZone())
    expect(result.actions).toContainEqual(
      expect.objectContaining({ name: 'desired-state', state: 'skipped' }),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET' })
  })

  it('probes an ArvanCloud zone with its server-side API-key authentication', async () => {
    let seen: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = init
        return new Response(JSON.stringify({ status: 'active' }), { status: 200 })
      }),
    )

    const result = await syncCdnZone(baseZone({ provider: 'arvancloud' }))
    expect(result.actions).toContainEqual(
      expect.objectContaining({ name: 'desired-state', state: 'skipped' }),
    )
    expect(new Headers(seen?.headers).get('authorization')).toBe('API KEY test-token')
  })

  it('rejects a non-HTTP DNS record marked proxied before writing a record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ result: [{ id: 'zone-1', name: 'example.com' }], success: true }),
            { status: 200 },
          ),
      ),
    )
    await expect(
      syncCdnZone(
        baseZone({
          active: true,
          dnsRecords: [{ content: 'mail.example.com', name: '@', proxied: true, type: 'MX' }],
        }),
      ),
    ).rejects.toBeInstanceOf(CdnConfigurationError)
  })
})
