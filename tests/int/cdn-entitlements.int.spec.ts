// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

import { syncCdnZone } from '@/cdn/service'
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

/** A fetch mock that returns 200 + {} for every ArvanCloud endpoint, recording calls. */
const arvanSyncFetch = () => {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    if (method === 'GET' && url.endsWith('/dns-records'))
      return new Response(JSON.stringify([]), { status: 200 })
    if (method === 'GET' && url.includes('/domains/') && !url.includes('/dns-records'))
      return new Response(
        JSON.stringify({ status: 'active', name_servers: ['ns1.arvancloud.ir'] }),
        { status: 200 },
      )
    if (method === 'POST' && url.endsWith('/dns-records'))
      return new Response(JSON.stringify({ id: 'rec-1' }), { status: 200 })
    return new Response(JSON.stringify({}), { status: 200 })
  })
  return { calls, fetch }
}

afterEach(() => vi.unstubAllGlobals())

describe('entitlement-gated security rules', () => {
  it('blocks custom WAF rules when the wafCustomRules entitlement is not confirmed', async () => {
    const { fetch } = arvanSyncFetch()
    vi.stubGlobal('fetch', fetch)
    const result = await syncCdnZone(
      baseZone({
        securityRules: [
          { action: 'block', expression: 'uri.path contains "/admin"', kind: 'waf' },
        ],
      }),
    )
    const blocked = result.actions.find((action) => action.name === 'security-rules')
    expect(blocked?.state).toBe('blocked')
    expect(blocked?.detail).toContain('wafCustomRules')
  })

  it('applies custom WAF rules when the wafCustomRules entitlement is confirmed', async () => {
    const { calls, fetch } = arvanSyncFetch()
    vi.stubGlobal('fetch', fetch)
    const result = await syncCdnZone(
      baseZone({
        capabilities: { wafCustomRules: true },
        securityRules: [
          { action: 'block', expression: 'uri.path contains "/admin"', kind: 'waf' },
        ],
      }),
    )
    const applied = result.actions.find((action) => action.name.startsWith('security:'))
    expect(applied?.state).toBe('applied')
    const ruleCall = calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/waf/rules'),
    )
    expect(ruleCall?.body).toMatchObject({
      action: 'protect',
      url_pattern: 'uri.path contains "/admin"',
    })
  })
})
