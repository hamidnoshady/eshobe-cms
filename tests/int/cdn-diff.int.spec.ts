// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  ARVAN_CAPABILITIES,
  CLOUDFLARE_CAPABILITIES,
  featureNote,
  supportsFeature,
} from '@/cdn/capabilities'
import { adoptRemoteRecords, diffCdnZone, formatCdnAdoptionSummary } from '@/cdn/diff'
import type { CdnRemoteState, CdnZoneInput } from '@/cdn/types'

describe('provider capability matrix', () => {
  it('ArvanCloud does not expose a zone-level ssl.mode or strict origin validation', () => {
    expect(supportsFeature('arvancloud', 'ssl.mode')).toBe(false)
    expect(supportsFeature('arvancloud', 'origin.strictTls')).toBe(false)
    expect(supportsFeature('arvancloud', 'cache.mode')).toBe(false)
    expect(supportsFeature('arvancloud', 'security.level')).toBe(false)
    // …but it does expose origin HTTPS, port, Host/SNI and per-record proxy.
    expect(supportsFeature('arvancloud', 'origin.https')).toBe(true)
    expect(supportsFeature('arvancloud', 'origin.port')).toBe(true)
    expect(supportsFeature('arvancloud', 'origin.hostHeader')).toBe(true)
    expect(supportsFeature('arvancloud', 'dns.proxy')).toBe(true)
  })

  it('Cloudflare supports ssl.mode and strict validation but not a per-record origin port', () => {
    expect(supportsFeature('cloudflare', 'ssl.mode')).toBe(true)
    expect(supportsFeature('cloudflare', 'origin.strictTls')).toBe(true)
    expect(supportsFeature('cloudflare', 'origin.port')).toBe(false)
    expect(supportsFeature('cloudflare', 'cache.mode')).toBe(true)
  })

  it('explains why a feature is unsupported', () => {
    expect(featureNote('arvancloud', 'ssl.mode')).toContain('upstream_https')
    expect(featureNote('cloudflare', 'origin.port')).toContain('origin port')
  })

  it('every feature has a boolean in both providers', () => {
    const cf = Object.keys(CLOUDFLARE_CAPABILITIES.features).sort()
    const ar = Object.keys(ARVAN_CAPABILITIES.features).sort()
    expect(cf).toEqual(ar)
    for (const feature of cf) {
      expect(typeof CLOUDFLARE_CAPABILITIES.features[feature as keyof typeof CLOUDFLARE_CAPABILITIES.features]).toBe('boolean')
      expect(typeof ARVAN_CAPABILITIES.features[feature as keyof typeof ARVAN_CAPABILITIES.features]).toBe('boolean')
    }
  })
})

const zone: CdnZoneInput = {
  active: true,
  credentials: { apiToken: 'enc:v1:x' },
  dnsRecords: [
    // CMS-owned, matches remote → in-sync
    { content: '203.0.113.10', name: '@', providerRecordId: 'r1', proxied: true, type: 'A' },
    // CMS-owned, differs from remote → drifted
    { content: '198.51.100.20', name: 'www', providerRecordId: 'r2', proxied: true, type: 'A' },
    // no provider id, no remote match → new
    { content: '192.0.2.30', name: 'api', proxied: false, type: 'A' },
    // same name/type as a foreign remote record, no provider id → external (not adopted)
    { content: '198.51.100.99', name: 'mail', proxied: false, type: 'MX' },
  ],
  hsts: { enabled: true },
  id: 'zone-1',
  provider: 'cloudflare',
  ssl: { mode: 'strict', minimumTls: '1.2' },
  zoneName: 'example.com',
}

const remote: CdnRemoteState = {
  dnsRecords: [
    { content: '203.0.113.10', name: 'example.com', proxied: true, providerRecordId: 'r1', type: 'A' },
    { content: '198.51.100.5', name: 'www.example.com', proxied: true, providerRecordId: 'r2', type: 'A' },
    { content: 'mx.example.com', name: 'mail.example.com', proxied: false, providerRecordId: 'foreign-1', type: 'MX' },
    // remote-only, not in desired → external
    { content: '_acme-challenge', name: '_acme-challenge.example.com', proxied: false, providerRecordId: 'acme-1', type: 'TXT' },
  ],
  nameservers: ['ns1', 'ns2'],
  providerZoneId: 'cf-zone',
  readAt: '2026-11-01T00:00:00.000Z',
  settings: { hsts: { enabled: false }, minimumTls: '1.3', mode: 'full' },
  status: 'active',
  zoneName: 'example.com',
}

describe('dry-run diff', () => {
  it('classifies DNS records and settings without mutating anything', () => {
    const result = diffCdnZone(zone, remote)
    const byName = new Map(result.items.map((item) => [`${item.kind}:${item.name}`, item]))

    // in-sync managed record
    expect(byName.get('dns:@')?.status).toBe('in-sync')
    // drifted managed record
    expect(byName.get('dns:www')?.status).toBe('drifted')
    expect(byName.get('dns:www')?.remote).toBe('198.51.100.5')
    // new record
    expect(byName.get('dns:api')?.status).toBe('new')
    // foreign same-name record is not adopted
    expect(byName.get('dns:mail')?.status).toBe('external')
    // remote-only record is external
    expect(byName.get('dns:_acme-challenge')?.status).toBe('external')

    // settings
    expect(byName.get('setting:ssl.mode')?.status).toBe('drifted')
    expect(byName.get('setting:ssl.minimumTls')?.status).toBe('drifted')
    expect(byName.get('setting:hsts.enabled')?.status).toBe('drifted')
  })

  it('reports unsupported settings for ArvanCloud instead of drifting them', () => {
    const arvanZone: CdnZoneInput = { ...zone, provider: 'arvancloud' }
    const result = diffCdnZone(arvanZone, remote)
    const sslMode = result.items.find((item) => item.name === 'ssl.mode')
    expect(sslMode?.status).toBe('unsupported')
    expect(sslMode?.detail).toContain('upstream_https')
  })

  it('produces a summary with the right counts', () => {
    const result = diffCdnZone(zone, remote)
    expect(result.summary.new).toBe(1)
    expect(result.summary['in-sync']).toBe(1)
    expect(result.summary.drifted).toBe(4) // dns:www + ssl.mode + ssl.minimumTls + hsts
    expect(result.summary.external).toBe(2) // dns:mail + dns:_acme-challenge
  })
})

describe('selective adoption', () => {
  it('links an adopted foreign record to an existing desired record', () => {
    const result = adoptRemoteRecords(zone, remote, ['foreign-1'])
    // The desired `mail` record now owns the remote id.
    const mail = result.zone.dnsRecords!.find((r) => r.name === 'mail')
    expect(mail?.providerRecordId).toBe('foreign-1')
    expect(result.adopted).toEqual([
      { name: 'mail.example.com', providerRecordId: 'foreign-1', type: 'MX' },
    ])
    expect(result.refused).toEqual([])
    // After adoption, the diff no longer reports it as external.
    const diff = diffCdnZone(result.zone, remote)
    expect(diff.items.find((i) => i.name === 'mail')?.status).toBe('drifted')
  })

  it('creates a new desired record when none exists for the adopted remote record', () => {
    const result = adoptRemoteRecords(zone, remote, ['acme-1'])
    const acme = result.zone.dnsRecords!.find((r) => r.name === '_acme-challenge')
    expect(acme).toMatchObject({
      content: '_acme-challenge',
      providerRecordId: 'acme-1',
      type: 'TXT',
    })
  })

  it('refuses a remote id that does not exist', () => {
    const result = adoptRemoteRecords(zone, remote, ['does-not-exist'])
    expect(result.refused).toEqual([{ name: 'does-not-exist', reason: 'remote record not found' }])
    expect(result.adopted).toEqual([])
  })

  it('produces an audit summary of what was adopted and refused', () => {
    const result = adoptRemoteRecords(zone, remote, ['foreign-1', 'does-not-exist'])
    const summary = formatCdnAdoptionSummary(result)
    expect(summary).toContain('Adopted 1 remote record(s)')
    expect(summary).toContain('MX mail.example.com')
    expect(summary).toContain('Refused 1 record(s)')
    expect(summary).toContain('does-not-exist (remote record not found)')
  })
})
