// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { stampCdnOriginOverride } from '@/collections/hooks/cdnZoneSecrets'
import { resolveOriginTarget, TenantCdnRefusal } from '@/cdn/tenant'

describe('per-zone origin resolution', () => {
  it('prefers a zone override over the shared account origin', () => {
    const resolved = resolveOriginTarget('198.51.100.7', '203.0.113.10', 'Srv2 theme app')
    expect(resolved).toEqual({
      originTarget: '198.51.100.7',
      reason: 'Srv2 theme app',
      source: 'zone',
    })
  })

  it('falls back to the account origin when the zone has none', () => {
    const resolved = resolveOriginTarget(null, '203.0.113.10')
    expect(resolved).toEqual({ originTarget: '203.0.113.10', source: 'account' })
  })

  it('treats whitespace-only overrides as absent', () => {
    const resolved = resolveOriginTarget('   ', '203.0.113.10')
    expect(resolved.source).toBe('account')
  })

  it('refuses when neither the zone nor the account has a usable origin', () => {
    expect(() => resolveOriginTarget(null, '')).toThrow(TenantCdnRefusal)
  })
})

describe('origin override stamp', () => {
  const run = (data: Record<string, unknown>, originalDoc?: Record<string, unknown>) =>
    stampCdnOriginOverride({
      data,
      operation: originalDoc ? 'update' : 'create',
      originalDoc,
    } as never)

  it('stamps the override time when a zone origin is first set', async () => {
    const result = await run({ originTarget: '198.51.100.7' })
    expect(result.originOverrideAt).toEqual(expect.any(String))
  })

  it('does not re-stamp when the origin is unchanged', async () => {
    const original = { originTarget: '198.51.100.7', originOverrideAt: '2026-01-01T00:00:00.000Z' }
    const result = await run({ originTarget: '198.51.100.7' }, original)
    expect(result.originOverrideAt).toBeUndefined()
  })

  it('clears the stamp when the override is removed', async () => {
    const original = { originTarget: '198.51.100.7', originOverrideAt: '2026-01-01T00:00:00.000Z' }
    const result = await run({ originTarget: '' }, original)
    expect(result.originOverrideAt).toBeNull()
  })
})
