import { afterEach, describe, expect, it, vi } from 'vitest'

import { decryptDomainResellerSecret, encryptDomainResellerSecret } from '@/domain-reseller/crypto'
import {
  callResellerArea,
  DomainResellerProviderError,
  productForDomain,
  quoteFor,
  type ResellerProduct,
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
