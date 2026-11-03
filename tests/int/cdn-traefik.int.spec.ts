// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { traefikDns01Config, zoneCertificateDomains } from '@/cdn/traefik'
import type { CdnZoneInput } from '@/cdn/types'

const baseZone = (overrides: Partial<CdnZoneInput> = {}): CdnZoneInput => ({
  active: true,
  arvan: {},
  credentials: { apiToken: 'test-token' },
  dnsRecords: [
    { content: '203.0.113.10', name: '@', proxied: true, type: 'A' },
    { content: 'example.com', name: 'www', proxied: true, type: 'CNAME' },
  ],
  id: '00000000-0000-4000-8000-000000000001',
  provider: 'arvancloud',
  ssl: { mode: 'strict' },
  zoneName: 'example.com',
  ...overrides,
})

describe('traefik DNS-01 provisioning', () => {
  it('generates an ACME resolver wired to the DNS-01 challenge', () => {
    const config = traefikDns01Config({
      domains: ['example.com', 'www.example.com'],
      dnsProvider: 'arvancloud',
      email: 'admin@example.com',
      storage: '/acme/example.json',
    })
    expect(config.certificatesResolvers.cms.acme.email).toBe('admin@example.com')
    expect(config.certificatesResolvers.cms.acme.storage).toBe('/acme/example.json')
    expect(config.certificatesResolvers.cms.acme.dnsChallenge.provider).toBe('arvancloud')
    expect(config.certificates[0]).toEqual({
      certResolver: 'cms',
      domains: ['example.com', 'www.example.com'],
    })
  })

  it('includes overrideDNS when DNS servers are provided', () => {
    const config = traefikDns01Config({
      domains: ['example.com'],
      dnsProvider: 'arvancloud',
      email: 'admin@example.com',
      overrideDNS: ['ns1.arvancloud.ir', 'ns2.arvancloud.ir'],
      storage: '/acme/example.json',
    })
    expect(config.certificatesResolvers.cms.acme.dnsChallenge.overrideDNS).toEqual([
      'ns1.arvancloud.ir',
      'ns2.arvancloud.ir',
    ])
  })

  it('derives certificate domains from the zone apex and record names', () => {
    const domains = zoneCertificateDomains(baseZone())
    expect(domains).toEqual(['example.com', 'www.example.com'])
  })

  it('covers the apex when a record name is already an FQDN', () => {
    const zone = baseZone({
      dnsRecords: [
        { content: '203.0.113.10', name: 'example.com', proxied: true, type: 'A' },
      ],
    })
    expect(zoneCertificateDomains(zone)).toEqual(['example.com'])
  })
})
