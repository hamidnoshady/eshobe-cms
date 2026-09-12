import { afterEach, describe, expect, it, vi } from 'vitest'

import { decryptDomainResellerSecret, encryptDomainResellerSecret } from '@/domain-reseller/crypto'
import {
  availabilityFromProviderError,
  callResellerArea,
  DomainResellerProviderError,
  operationsForAvailability,
  productForDomain,
  quoteFor,
  type ResellerProduct,
  whoisIndicatesRegistered,
} from '@/domain-reseller/service'

const products: ResellerProduct[] = [
  {
    currency: 'IRT',
    enabled: true,
    registrationCost: 100_000,
    renewalCost: 90_000,
    tld: 'ir',
    transferCost: 80_000,
  },
  {
    currency: 'IRT',
    enabled: true,
    registrationCost: 200_000,
    renewalCost: 190_000,
    tld: 'co.ir',
    transferCost: 180_000,
  },
]

describe('IRPower / ResellerArea domain reseller boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('seals the platform API key and fails closed after ciphertext tampering', () => {
    const previous = process.env.DOMAIN_RESELLER_KEY
    process.env.DOMAIN_RESELLER_KEY = 'a-dedicated-domain-reseller-test-key-at-least-32-characters'
    try {
      const encrypted = encryptDomainResellerSecret('irpower-platform-api-key')
      expect(encrypted).not.toContain('irpower-platform-api-key')
      expect(decryptDomainResellerSecret(encrypted)).toBe('irpower-platform-api-key')
      // The final base64url character may contain unused padding bits; alter a byte-bearing
      // position so the GCM tag/ciphertext necessarily changes.
      const position = encrypted.length - 3
      const character = encrypted.at(position)
      expect(
        decryptDomainResellerSecret(
          `${encrypted.slice(0, position)}${character === 'x' ? 'y' : 'x'}${encrypted.slice(position + 1)}`,
        ),
      ).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.DOMAIN_RESELLER_KEY
      else process.env.DOMAIN_RESELLER_KEY = previous
    }
  })

  it('uses the most-specific manual TLD cost and snapshots the global margin', () => {
    expect(productForDomain('shop.example.co.ir', products)?.tld).toBe('co.ir')

    expect(
      quoteFor({
        marginPercentage: 12.5,
        operation: 'register',
        period: 2,
        product: products[1]!,
      }),
    ).toEqual({
      catalogueCost: 400_000,
      currency: 'IRT',
      marginPercentage: 12.5,
      operation: 'register',
      period: 2,
      price: 450_000,
      tld: 'co.ir',
    })
  })

  it('sends documented JSON POST authentication without exposing the provider request elsewhere', async () => {
    let seen: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen = init
        return new Response(JSON.stringify({ success: true, result: { ns1: 'ns1.example.net' } }), {
          status: 200,
        })
      }),
    )

    await expect(
      callResellerArea(
        { apiEndpoint: 'https://resellerarea.net/api', apiKey: 'platform-only-secret' },
        'GetDomainNameServers',
        { domain: 'example.ir' },
      ),
    ).resolves.toEqual({ ns1: 'ns1.example.net' })

    expect(seen?.method).toBe('POST')
    expect(seen?.redirect).toBe('error')
    expect(new Headers(seen?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(seen?.headers).get('x-api-key')).toBe('platform-only-secret')
    expect(JSON.parse(String(seen?.body))).toEqual({
      command: 'GetDomainNameServers',
      domain: 'example.ir',
    })
  })

  it('converts a registrar rejection to a controlled provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ code: 6019, message: 'Contacts do not have needed access.' }],
              success: false,
            }),
            { status: 200 },
          ),
      ),
    )

    await expect(
      callResellerArea(
        { apiEndpoint: 'https://resellerarea.net/api', apiKey: 'platform-only-secret' },
        'IsValidTransfer',
        { domain: 'example.ir', transfer_type: 'OwnerTransfer' },
      ),
    ).rejects.toMatchObject({
      code: 6019,
      status: 200,
    } satisfies Partial<DomainResellerProviderError>)
  })
})

describe('domain availability inferred from the documented WHOIS command', () => {
  it('reads WHOIS contacts as proof of registration, and an empty result as proof of nothing', () => {
    expect(whoisIndicatesRegistered({ registrant: { first_name: 'Sample' } })).toBe(true)
    expect(whoisIndicatesRegistered({ billing: { email: 'a@b.c' } })).toBe(true)
    // A success with no contact object says the name is taken by nobody the provider
    // will name — which is not the same as free, and must not be sold as free.
    expect(whoisIndicatesRegistered({})).toBe(false)
    expect(whoisIndicatesRegistered(undefined)).toBe(false)
    expect(whoisIndicatesRegistered('ok')).toBe(false)
  })

  it('calls a domain available only when the registrar says it is not registered', () => {
    expect(
      availabilityFromProviderError(new DomainResellerProviderError('Domain not found.')),
    ).toBe('available')
    expect(
      availabilityFromProviderError(new DomainResellerProviderError('No match for domain')),
    ).toBe('available')
    expect(
      availabilityFromProviderError(new DomainResellerProviderError('دامنه ثبت نشده است')),
    ).toBe('available')

    // Every other failure is an outage, a bad key, or a rate limit — never a sale signal.
    expect(
      availabilityFromProviderError(
        new DomainResellerProviderError('ارتباط با registrar برقرار نشد.'),
      ),
    ).toBe('unknown')
    expect(
      availabilityFromProviderError(
        new DomainResellerProviderError('Invalid API key', { code: 401 }),
      ),
    ).toBe('unknown')
    expect(availabilityFromProviderError(new Error('boom'))).toBe('unknown')
  })

  it('offers only the operation the registrar could actually accept', () => {
    expect(operationsForAvailability('available')).toEqual(['register'])
    expect(operationsForAvailability('registered')).toEqual(['transfer'])
    // RenewDomain is documented as reseller-account-only, so a renew button appears
    // solely for a domain this platform already got accepted for this same site.
    expect(operationsForAvailability('managedHere', 'providerAccepted')).toEqual(['renew'])
    expect(operationsForAvailability('managedHere', 'requested')).toEqual([])
    // Another tenant's in-flight name is not orderable, and says nothing about its owner.
    expect(operationsForAvailability('reservedInPlatform')).toEqual([])
    // Unverified leaves the choice with the buyer; the registrar remains the authority.
    expect(operationsForAvailability('unknown')).toEqual(['register', 'transfer'])
  })
})
