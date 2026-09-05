import { describe, expect, it } from 'vitest'

import {
  domainAliasForHost,
  isValidDomain,
  normalizeDomain,
  siteHostMatch,
  siteHostnames,
} from '@/lib/domains'

const site = {
  domain: 'acme.example.com',
  domainVerified: true,
  domains: [
    { hostname: 'www.acme.example.com', id: 'www', verified: true },
    { hostname: 'shop.acme.example.com', id: 'shop', verified: false },
  ],
}

describe('tenant domain helpers', () => {
  it('normalizes one DNS hostname spelling and rejects URLs, paths and malformed labels', () => {
    expect(normalizeDomain('  WWW.Acme.Example.Com.  ')).toBe('www.acme.example.com')
    expect(isValidDomain('www.acme.example.com')).toBe(true)
    expect(isValidDomain('acme.localhost')).toBe(true)
    expect(isValidDomain('https://acme.example.com')).toBe(false)
    expect(isValidDomain('acme.example.com/path')).toBe(false)
    expect(isValidDomain('bad_.example.com')).toBe(false)
    expect(isValidDomain('-bad.example.com')).toBe(false)
  })

  it('resolves the primary hostname and only aliases individually verified for this site', () => {
    expect(siteHostMatch(site, 'acme.example.com:3000')).toEqual({
      canonical: true,
      hostname: 'acme.example.com',
      verified: true,
    })
    expect(siteHostMatch(site, 'WWW.ACME.EXAMPLE.COM')).toEqual({
      canonical: false,
      hostname: 'www.acme.example.com',
      verified: true,
    })
    expect(siteHostMatch(site, 'shop.acme.example.com')).toBeNull()
    expect(domainAliasForHost(site, 'shop.acme.example.com')).toMatchObject({ verified: false })
  })

  it('lists all hostnames so cross-tenant collision checks include aliases', () => {
    expect(siteHostnames(site)).toEqual([
      'acme.example.com',
      'www.acme.example.com',
      'shop.acme.example.com',
    ])
  })
})
