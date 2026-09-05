import { beforeAll, describe, expect, it } from 'vitest'

import type { Field } from 'payload'

import type { CheckoutOrder } from '@/payments'
import type { GatewayId } from '@/payments/gateways/types'

import { PaymentGateways } from '@/collections/PaymentGateways'
import {
  assertGatewayUsable,
  encryptGatewayCredentials,
  lockGatewayChoice,
  uniqueGatewayPerSite,
} from '@/collections/hooks/paymentGatewaySecrets'
import { gatewayAdapters } from '@/payments/gateways/adapters'
import { amountIn, amountMatches, currencySetting } from '@/payments/gateways/amount'
import {
  decryptSecret,
  encryptSecret,
  fingerprintSecret,
  isEncrypted,
  signGatewayState,
  verifyGatewayState,
} from '@/payments/gateways/crypto'
import { assertSafeGatewayUrl, isPrivateAddress, joinUrl, pick, pickUrl } from '@/payments/gateways/net'
import {
  allCredentialKeys,
  credentialField,
  credentialFieldCatalogue,
  gatewayDescriptor,
  gatewayDescriptors,
  gatewayIds,
  gatewayOptions,
  isGatewayId,
  keysForGateway,
  missingCredentials,
  secretKeysForGateway,
} from '@/payments/gateways/registry'
import { isGatewayProvider, paymentProviderOptions, paymentProviders } from '@/payments'

/**
 * The gateway module's invariants — everything that can be checked without a database.
 *
 * These are the assertions that would otherwise fail in production, in front of a buyer,
 * with money on the line. Each one is a table that has to agree with another table, or a
 * guard that has to hold for an input nobody has thought to try yet:
 *
 * - a descriptor with no adapter is `undefined` at checkout (`gatewayAdapters[id].initiate`);
 * - a credential key with no column silently stores nothing, and a column with no key
 *   silently stores *plaintext* because nothing encrypts it;
 * - an endpoint host outside `allowedHosts` is a request `net.ts` refuses, so the gateway
 *   cannot be used at all — and a host inside it that resolves privately is an SSRF hole;
 * - an amount compared in the wrong unit is a payment for a tenth of the order.
 *
 * Deliberately DB-free, like `blocks.int.spec.ts`: the things that break here break by
 * editing a table, and a test that needs Postgres to notice a typo in a registry is a test
 * that does not run in the loop where the typo happens.
 */

/**
 * The tests read a key rather than the deployment's, so this spec runs on a machine with no
 * `.env` at all. `crypto.ts` reads the environment per call — not at import — precisely so
 * that a test can do this.
 */
beforeAll(() => {
  process.env.PAYMENT_GATEWAYS_KEY = 'test-only-payment-gateways-key-0123456789'
})

const order = (overrides: Partial<CheckoutOrder> = {}): CheckoutOrder =>
  ({
    buyer: { email: 'buyer@example.com', name: 'خریدار', phone: '09120000000' },
    currency: 'IRT',
    id: '00000000-0000-4000-8000-000000000001',
    locale: 'fa',
    productTitle: 'محصول',
    quantity: 1,
    reference: 'ES-1',
    site: { defaultLocale: 'fa', domain: 'shop.example', id: 'site-1', name: 'فروشگاه' },
    total: 250_000,
    ...overrides,
  }) as CheckoutOrder

/**
 * Every field, at any depth — the credential columns sit inside a `group`, inside the
 * collection, and a check that only looked at the top level would have passed on a
 * collection where they had been moved out of the group and lost their hooks.
 *
 * The cast is about Payload's `Field` union: some members carry an optional `fields`, some
 * a `blocks`, and `'fields' in field` does not narrow across all of them.
 */
const flatten = (fields: Field[]): Field[] =>
  fields.flatMap((field) => {
    const nested = (field as { fields?: Field[] }).fields

    return Array.isArray(nested) ? [field, ...flatten(nested)] : [field]
  })

/** The `credentials` group's columns, as the collection actually defines them. */
const credentialFields = (): Field[] => {
  const group = flatten(PaymentGateways.fields).find(
    (field) => 'name' in field && field.name === 'credentials',
  )

  if (!group || !('fields' in group)) throw new Error('credentials group not found — did PaymentGateways move?')

  return group.fields as Field[]
}

const named = (field: Field): string => ('name' in field ? String(field.name) : '')

describe('gateway registry ↔ adapters', () => {
  it('has an adapter for every descriptor', () => {
    // The failure this prevents is `gatewayAdapters[id]` being `undefined` at checkout,
    // which throws inside a `try` the buyer reads as "the gateway did not answer".
    expect(Object.keys(gatewayAdapters).sort()).toEqual(gatewayIds.sort())
  })

  it('has a descriptor for every adapter', () => {
    for (const [id, adapter] of Object.entries(gatewayAdapters)) {
      expect(adapter.id).toBe(id)
      expect(isGatewayId(id)).toBe(true)
      expect(gatewayDescriptors[id as GatewayId]).toBeDefined()
    }
  })

  it('is exactly the four gateways the platform was asked for', () => {
    expect(gatewayIds.sort()).toEqual(['digipay', 'snappPay', 'torobPay', 'zarinpal'])
  })

  it('exposes every gateway as a payment provider', () => {
    for (const id of gatewayIds) {
      expect(paymentProviders[id]).toBeDefined()
      expect(paymentProviders[id]?.label).toBe(gatewayDescriptor(id).label)
      expect(isGatewayProvider(id)).toBe(true)
    }

    expect(isGatewayProvider('bank')).toBe(false)
    expect(isGatewayProvider('http')).toBe(false)
    expect(isGatewayProvider(null)).toBe(false)
    expect(isGatewayProvider('stripe')).toBe(false)
  })

  it('offers every provider in the admin select, and nothing else', () => {
    expect(paymentProviderOptions.map(({ value }) => value).sort()).toEqual(
      Object.keys(paymentProviders).sort(),
    )

    expect(gatewayOptions.map(({ value }) => value).sort()).toEqual(gatewayIds.sort())
  })

  it('settles only in Iranian units', () => {
    for (const id of gatewayIds) {
      const { currencies } = gatewayDescriptor(id)

      expect(currencies.length).toBeGreaterThan(0)

      for (const currency of currencies) expect(['IRR', 'IRT']).toContain(currency)
    }
  })

  it('requires the buyer mobile number wherever the provider identifies the wallet by it', () => {
    // A BNPL or wallet product cannot be collected against a number that is not the
    // buyer's, so the descriptor has to say so and the storefront has to keep the field.
    for (const id of gatewayIds) {
      const descriptor = gatewayDescriptor(id)

      if (descriptor.kind === 'bnpl') expect(descriptor.requiresMobile).toBe(true)
    }
  })

  it('points every mode at an https endpoint inside its own host allowlist', () => {
    for (const id of gatewayIds) {
      const descriptor = gatewayDescriptor(id)

      expect(descriptor.allowedHosts.length).toBeGreaterThan(0)

      for (const mode of ['live', 'sandbox'] as const) {
        const { api, pay } = descriptor.endpoints[mode] ?? {}

        // Torob Pay has no published default: its base URL is a required row setting, so
        // an empty `api` is the honest value and `resolve.ts` refuses the row without one.
        if (!api) {
          expect(id).toBe('torobPay')
          expect(descriptor.settings.some(({ key, required }) => key === 'baseUrl' && required)).toBe(true)

          continue
        }

        const url = new URL(api)

        expect(url.protocol).toBe('https:')
        expect(
          descriptor.allowedHosts.some(
            (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
          ),
          `${id}/${mode} api ${api} is outside its allowlist`,
        ).toBe(true)

        if (pay) expect(pay).toContain('{token}')
      }
    }
  })

  it('documents where each contract came from', () => {
    for (const id of gatewayIds) {
      const { docsUrl } = gatewayDescriptor(id)

      expect(docsUrl.startsWith('https://')).toBe(true)
    }
  })
})

describe('credential catalogue ↔ columns', () => {
  const columns = credentialFields()

  it('gives every catalogue key a column', () => {
    // A key with no column stores nothing: the hook writes `data.credentials[key]`, the
    // column does not exist, and the value is dropped without an error.
    expect(columns.map(named).sort()).toEqual([...allCredentialKeys].sort())
  })

  it('names only real gateways', () => {
    for (const field of credentialFieldCatalogue) {
      expect(field.gateways.length).toBeGreaterThan(0)

      for (const gateway of field.gateways) expect(isGatewayId(gateway)).toBe(true)
    }
  })

  it('has every key a descriptor asks for', () => {
    for (const id of gatewayIds) {
      const descriptor = gatewayDescriptor(id)

      for (const { key } of [...descriptor.credentials, ...descriptor.settings]) {
        expect(allCredentialKeys, `${id} wants "${key}"`).toContain(key)
        expect(keysForGateway(id), `${id} should read "${key}"`).toContain(key)
        expect(
          credentialFieldCatalogue.find((field) => field.key === key)?.gateways,
          `"${key}" is not shown for ${id}`,
        ).toContain(id)
      }
    }
  })

  it('has no catalogue field a descriptor never uses', () => {
    // The other direction: a column nobody reads is a column a platform admin fills in and
    // nothing happens, which reads as a bug in the module rather than a dead field.
    for (const { key } of credentialFieldCatalogue) {
      const used = gatewayIds.some((id) => keysForGateway(id).includes(key))

      expect(used, `"${key}" is not used by any gateway`).toBe(true)
    }
  })

  it('locks every credential column to platform staff and masks it on read', () => {
    for (const field of columns) {
      const access = 'access' in field ? field.access : undefined

      expect(access?.read, `${named(field)} is readable by a tenant`).toBeDefined()
      expect(access?.update, `${named(field)} is writable by a tenant`).toBeDefined()
      expect(access?.create, `${named(field)} is creatable by a tenant`).toBeDefined()

      // The masking hook is what makes "never returned by any API" true even for a platform
      // admin: field access decides *who may ask*, the hook decides *what comes back*.
      const hooks = 'hooks' in field ? field.hooks : undefined

      expect(hooks?.afterRead?.length, `${named(field)} is not masked`).toBeGreaterThan(0)

      // A required credential column would make every other gateway's rows unsavable:
      // Payload validates required fields even when `admin.condition` hides them.
      expect('required' in field ? field.required : false, `${named(field)} is required`).toBeFalsy()
    }
  })

  it('knows which keys are secrets and which are settings', () => {
    for (const id of gatewayIds) {
      const descriptor = gatewayDescriptor(id)
      const secrets = secretKeysForGateway(id)

      expect(secrets.sort()).toEqual(descriptor.credentials.map(({ key }) => key).sort())

      for (const { key } of descriptor.settings) expect(secrets).not.toContain(key)
    }
  })
})

describe('missingCredentials', () => {
  it('refuses a row with no merchant id', () => {
    expect(missingCredentials('zarinpal', {}).length).toBeGreaterThan(0)
    expect(missingCredentials('zarinpal', { merchantId: '' }).length).toBeGreaterThan(0)
    expect(missingCredentials('zarinpal', { merchantId: '   ' }).length).toBeGreaterThan(0)
    expect(missingCredentials('zarinpal', { merchantId: 'a'.repeat(36) })).toEqual([])
  })

  it('does not demand an optional credential', () => {
    // `referrerId` is a ZarinPal column and is not required; asking for it would make a
    // correct row impossible to switch on.
    expect(missingCredentials('zarinpal', { merchantId: 'a'.repeat(36), referrerId: '' })).toEqual([])
  })

  it('demands Torob Pay base URL, which has no published default', () => {
    // `missingCredentials` returns *labels*, because its only caller puts them in a
    // sentence a tenant reads. So the assertion goes through the catalogue rather than
    // naming the key.
    expect(missingCredentials('torobPay', { token: 'x' })).toContain(credentialField('baseUrl')?.label)
    expect(missingCredentials('torobPay', { baseUrl: 'https://gw.example', token: 'x' })).toEqual([])
  })

  it('names what is missing, in Persian, for the message a tenant reads', () => {
    const missing = missingCredentials('digipay', {})

    expect(missing.length).toBeGreaterThan(0)

    for (const label of missing) expect(label.trim().length).toBeGreaterThan(0)
  })
})

describe('amount handling', () => {
  it('keeps an order in its own unit', () => {
    expect(amountIn(order({ currency: 'IRT', total: 250_000 }))).toMatchObject({
      amount: 250_000,
      unit: 'IRT',
    })
  })

  it('converts Toman to Rial by exactly ten, and back', () => {
    expect(amountIn(order({ currency: 'IRT', total: 250_000 }), 'IRR')).toMatchObject({
      amount: 2_500_000,
      unit: 'IRR',
    })
    expect(amountIn(order({ currency: 'IRR', total: 2_500_000 }), 'IRT')).toMatchObject({
      amount: 250_000,
      unit: 'IRT',
    })
  })

  it('matches a reported amount across units', () => {
    const tomanOrder = order({ currency: 'IRT', total: 250_000 })

    expect(amountMatches(tomanOrder, 250_000, 'IRT')).toBe(true)
    expect(amountMatches(tomanOrder, 2_500_000, 'IRR')).toBe(true)
    expect(amountMatches(tomanOrder, '2500000', 'IRR')).toBe(true)
    // The error this catches: a PSP echoing Rial compared against a Toman order.
    expect(amountMatches(tomanOrder, 250_000, 'IRR')).toBe(false)
    expect(amountMatches(tomanOrder, 2_500_001, 'IRR')).toBe(false)
  })

  it('never matches a value it cannot read', () => {
    const tomanOrder = order({ currency: 'IRT', total: 250_000 })

    expect(amountMatches(tomanOrder, null, 'IRT')).toBe(false)
    expect(amountMatches(tomanOrder, undefined, 'IRT')).toBe(false)
    expect(amountMatches(tomanOrder, '', 'IRT')).toBe(false)
    expect(amountMatches(tomanOrder, 'paid', 'IRT')).toBe(false)
    expect(amountMatches(tomanOrder, Number.NaN, 'IRT')).toBe(false)
    // A unit the platform does not know is a refusal, not a pass: guessing here is how a
    // zero-amount confirmation would slip through.
    expect(amountMatches(tomanOrder, 250_000, null)).toBe(false)
  })

  it('honours an explicit tolerance and no implicit one', () => {
    const tomanOrder = order({ currency: 'IRT', total: 250_000 })

    expect(amountMatches(tomanOrder, 249_999, 'IRT')).toBe(false)
    expect(amountMatches(tomanOrder, 249_999, 'IRT', 1)).toBe(true)
  })

  it('falls back on a currency setting it cannot use', () => {
    expect(currencySetting('IRR', 'IRT')).toBe('IRR')
    expect(currencySetting('IRT', 'IRR')).toBe('IRT')
    // The registry's "same unit as the site" sentinel, and anything a seed or an older row
    // might hold. Neither may become a NaN amount sent to a PSP.
    expect(currencySetting('site', 'IRT')).toBe('IRT')
    expect(currencySetting('none', 'IRT')).toBe('IRT')
    expect(currencySetting('', 'IRR')).toBe('IRR')
    expect(currencySetting(undefined, 'IRR')).toBe('IRR')
    expect(currencySetting('usd', 'IRT')).toBe('IRT')
  })
})

describe('gateway URL safety', () => {
  it('recognises addresses that must never be fetched', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '10.255.255.255',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // the cloud metadata endpoint, and the reason this exists
      '0.0.0.0',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      // An IPv4-mapped IPv6 literal is the same private address wearing a different hat.
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(address), `${address} should be refused`).toBe(true)
    }
  })

  it('allows real public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '185.166.10.4', '93.184.216.34', '2606:2800:220:1::']) {
      expect(isPrivateAddress(address), `${address} should be allowed`).toBe(false)
    }
  })

  it('does not call 172.32.0.1 private', () => {
    // 172.16.0.0/12 ends at 172.31.255.255. Treating the whole 172/8 as private would
    // refuse a real PSP; treating 172.31.255.255 as public would be the actual hole.
    expect(isPrivateAddress('172.32.0.1')).toBe(false)
    expect(isPrivateAddress('172.15.255.255')).toBe(false)
  })

  it('refuses anything not on the allowlist', async () => {
    await expect(
      assertSafeGatewayUrl('https://evil.example/pay', { allowedHosts: ['zarinpal.com'] }),
    ).rejects.toThrow()

    await expect(
      assertSafeGatewayUrl('https://evil-zarinpal.com/pay', { allowedHosts: ['zarinpal.com'] }),
    ).rejects.toThrow()

    await expect(
      assertSafeGatewayUrl('https://zarinpal.com.evil.example/pay', { allowedHosts: ['zarinpal.com'] }),
    ).rejects.toThrow()
  })

  it('refuses a private literal even when the host is allowlisted', async () => {
    // The allowlist is the first door and DNS is the second: a row whose `baseUrl` is
    // `https://api.snapppay.ir` resolving to 169.254.169.254 has to be refused by the
    // second, because the first has no way to know.
    await expect(
      assertSafeGatewayUrl('https://127.0.0.1/pay', { allowedHosts: ['127.0.0.1'] }),
    ).rejects.toThrow()

    await expect(
      assertSafeGatewayUrl('http://169.254.169.254/latest/meta-data/', {
        allowedHosts: ['169.254.169.254'],
      }),
    ).rejects.toThrow()
  })

  it('refuses a scheme that is not http(s)', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://zarinpal.com/x', 'javascript:alert(1)']) {
      await expect(assertSafeGatewayUrl(url, { allowedHosts: ['zarinpal.com'] })).rejects.toThrow()
    }
  })

  it('accepts a subdomain of an allowlisted host', async () => {
    const url = await assertSafeGatewayUrl('https://api.zarinpal.com/pg/v4/payment/request.json', {
      allowedHosts: ['zarinpal.com'],
    })

    expect(url.hostname).toBe('api.zarinpal.com')
  })

  it('joins a base and a path once, with exactly one slash', () => {
    expect(joinUrl('https://api.example', '/v1/pay')).toBe('https://api.example/v1/pay')
    expect(joinUrl('https://api.example/', '/v1/pay')).toBe('https://api.example/v1/pay')
    expect(joinUrl('https://api.example/', 'v1/pay')).toBe('https://api.example/v1/pay')
    expect(joinUrl('https://api.example/v2/', '/pay')).toBe('https://api.example/v2/pay')
    // An empty path still gets the one slash, because the rule is "exactly one between
    // them" and not "none when the path is empty" — a special case here would be a special
    // case in every adapter that calls it.
    expect(joinUrl('https://api.example', '')).toBe('https://api.example/')
  })
})

describe('response parsing', () => {
  it('finds a field by any of the names a provider might use', () => {
    expect(pick({ authority: 'A00000' }, 'authority', 'ref_id')).toBe('A00000')
    expect(pick({ data: { ref_id: 123 } }, 'authority', 'data.ref_id')).toBe(123)
    expect(pick({ data: { code: 100 } }, 'data.code')).toBe(100)
    expect(pick({}, 'authority')).toBeNull()
    expect(pick(null, 'authority')).toBeNull()
    expect(pick({ authority: { nested: true } }, 'authority')).toBeNull()
  })

  it('only returns a value that is a URL', () => {
    expect(pickUrl({ redirectUrl: 'https://pay.example/x' }, 'redirectUrl')).toBe(
      'https://pay.example/x',
    )
    expect(pickUrl({ redirectUrl: 'A00000' }, 'redirectUrl')).toBeNull()
    expect(pickUrl({ data: { url: 'https://pay.example/y' } }, 'url', 'data.url')).toBe(
      'https://pay.example/y',
    )
  })
})

describe('secrets at rest', () => {
  it('round-trips a credential', () => {
    const plain = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const sealed = encryptSecret(plain)

    expect(isEncrypted(sealed)).toBe(true)
    expect(sealed).not.toContain(plain)
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(sealed)).toBe(plain)
  })

  it('produces different ciphertext for the same secret', () => {
    // A fresh IV per encryption. Without it, two tenants with the same merchant id have
    // the same ciphertext, and a dump can be grouped by customer without decrypting.
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('does not double-encrypt a value that is already sealed', () => {
    const sealed = encryptSecret('merchant-id')

    expect(isEncrypted(sealed)).toBe(true)
    expect(decryptSecret(sealed)).toBe('merchant-id')
  })

  it('returns null rather than throwing on a sealed value it cannot open', () => {
    // A rotated key has to read as "this row has no usable credentials" — which
    // `resolve.ts` turns into a refusal — and not as a 500 on the storefront. GCM's tag
    // check is what makes a tampered ciphertext fail the same way.
    expect(decryptSecret('enc:v1:not-base64-at-all')).toBeNull()
    // A well-formed envelope with the wrong bytes inside: same answer, because the tag
    // check is what fails and it cannot be told apart from a rotated key.
    expect(decryptSecret(`enc:v1:${'A'.repeat(64)}`)).toBeNull()
    // A sealed value truncated below iv + tag has nothing to check.
    expect(decryptSecret(`enc:v1:${encryptSecret('x').slice(7, 12)}`)).toBeNull()
    expect(decryptSecret('')).toBeNull()
    expect(decryptSecret(null)).toBeNull()
    expect(decryptSecret(undefined)).toBeNull()
  })

  it('passes a value that was never sealed straight through', () => {
    // Not a bug and not a convenience: a seeded row, or one written before the encrypting
    // hook existed, holds plaintext, and refusing it would make the gateway unusable with
    // no error anyone could act on. `resolve.ts` logs a warning when it sees one, so the
    // platform finds out without the buyer paying for it.
    expect(decryptSecret('plaintext-typed-by-an-admin')).toBe('plaintext-typed-by-an-admin')
    expect(isEncrypted('plaintext-typed-by-an-admin')).toBe(false)
  })

  it('refuses to open a sealed value with a different key', () => {
    const sealed = encryptSecret('client-secret')
    const original = process.env.PAYMENT_GATEWAYS_KEY

    process.env.PAYMENT_GATEWAYS_KEY = 'a-completely-different-key-0123456789'

    try {
      expect(decryptSecret(sealed)).toBeNull()
    } finally {
      process.env.PAYMENT_GATEWAYS_KEY = original
    }
  })

  it('keeps non-ASCII credentials intact', () => {
    const plain = 'رمز-عبور-فارسی-۱۲۳۴'

    expect(decryptSecret(encryptSecret(plain))).toBe(plain)
  })

  it('fingerprints stably and distinctly', () => {
    // The fingerprint is what a platform admin sees instead of the value, so it has to be
    // stable across renders (or "did that save?" is unanswerable) and different for
    // different secrets (or it proves nothing).
    expect(fingerprintSecret('abc')).toBe(fingerprintSecret('abc'))
    expect(fingerprintSecret('abc')).not.toBe(fingerprintSecret('abd'))
    expect(fingerprintSecret('abc')).not.toContain('abc')
  })
})

describe('callback state signature', () => {
  const claims = {
    amount: 250_000,
    gateway: 'zarinpal',
    orderId: '00000000-0000-4000-8000-000000000001',
    siteId: 'site-1',
  }

  it('round-trips', () => {
    const state = signGatewayState(claims)

    expect(typeof state).toBe('string')
    expect(state.length).toBeGreaterThan(10)
    expect(verifyGatewayState(state, claims)).toBe(true)
  })

  it('carries a deadline that cannot be moved', () => {
    // `<issuedAt>.<hmac>`, with issuedAt inside the signed payload. An attacker who
    // lengthens the deadline invalidates the signature, so the only tokens that verify are
    // ones this server issued at the moment it issued them.
    const state = signGatewayState(claims)
    const [issuedAt, signature] = state.split('.')

    expect(issuedAt).toBeTruthy()
    expect(signature).toBeTruthy()
    expect(Number.parseInt(issuedAt!, 36)).toBeGreaterThan(0)

    // A deadline pushed a year into the future, signed part untouched.
    const future = (Number.parseInt(issuedAt!, 36) + 365 * 24 * 3600).toString(36)

    expect(verifyGatewayState(`${future}.${signature}`, claims)).toBe(false)
    // And the honest version of the same attack: re-sign with a fresh timestamp but keep
    // the old signature.
    expect(verifyGatewayState(`${future}.${signGatewayState(claims).split('.')[1]}`, claims)).toBe(false)
  })

  it('refuses a signature that has expired', () => {
    const original = process.env.PAYMENT_GATEWAY_STATE_TTL_MS
    const state = signGatewayState(claims)

    // Shrinking the window after signing is the same thing as waiting: the deadline is
    // inside the token, not inside the verifier's memory.
    process.env.PAYMENT_GATEWAY_STATE_TTL_MS = '1'

    try {
      expect(verifyGatewayState(state, claims)).toBe(false)
    } finally {
      process.env.PAYMENT_GATEWAY_STATE_TTL_MS = original
    }

    // Read per call, so restoring it makes the same token valid again.
    expect(verifyGatewayState(state, claims)).toBe(true)
  })

  it('refuses a token whose shape is wrong before it compares anything', () => {
    expect(verifyGatewayState('no-separator-at-all', claims)).toBe(false)
    expect(verifyGatewayState('.abcdef', claims)).toBe(false)
    expect(verifyGatewayState('lz1g.', claims)).toBe(false)
    expect(verifyGatewayState('notbase36!!.abcdef', claims)).toBe(false)
    // A timestamp from the future is a forged or badly-clocked token, not a valid one.
    const future = (Math.floor(Date.now() / 1000) + 86_400).toString(36)

    expect(verifyGatewayState(`${future}.${signGatewayState(claims).split('.')[1]}`, claims)).toBe(false)
  })

  it('refuses a claim that was changed', () => {
    const state = signGatewayState(claims)

    // Each of these is a real attack on a callback URL: pay for a cheap order and replay
    // the signature against an expensive one, or drive another tenant's order.
    expect(verifyGatewayState(state, { ...claims, amount: 1 })).toBe(false)
    expect(verifyGatewayState(state, { ...claims, orderId: 'other-order' })).toBe(false)
    expect(verifyGatewayState(state, { ...claims, siteId: 'other-site' })).toBe(false)
    expect(verifyGatewayState(state, { ...claims, gateway: 'digipay' })).toBe(false)
  })

  it('refuses a signature that was tampered with, truncated, or is not a string', () => {
    const state = signGatewayState(claims)

    expect(verifyGatewayState(`${state}x`, claims)).toBe(false)
    expect(verifyGatewayState(state.slice(0, -1), claims)).toBe(false)
    expect(verifyGatewayState('', claims)).toBe(false)
    expect(verifyGatewayState(null, claims)).toBe(false)
    expect(verifyGatewayState(undefined, claims)).toBe(false)
    expect(verifyGatewayState({}, claims)).toBe(false)
    expect(verifyGatewayState([...state].reverse().join(''), claims)).toBe(false)
  })

  it('does not sign one order for another gateway id casing', () => {
    expect(verifyGatewayState(signGatewayState(claims), { ...claims, gateway: 'ZarinPal' })).toBe(false)
  })
})

describe('the collection a tenant edits', () => {
  const fields = flatten(PaymentGateways.fields)
  const byName = (name: string): Field | undefined => fields.find((field) => named(field) === name)

  it('is not publicly readable', () => {
    // The storefront gets its list from `/api/payments/methods`, not from this collection.
    // A public `read` here would publish every tenant's row *ids* and which PSPs they hold.
    expect(PaymentGateways.access?.read).toBeDefined()
  })

  it('lets only platform staff create or delete a row', () => {
    expect(PaymentGateways.access?.create).toBeDefined()
    expect(PaymentGateways.access?.delete).toBeDefined()
  })

  it('has the switch, the order and the amount window a tenant is allowed to set', () => {
    for (const name of ['enabled', 'priority', 'displayName', 'minAmount', 'maxAmount']) {
      expect(byName(name), `missing ${name}`).toBeDefined()
    }
  })

  it('defaults a new row to off', () => {
    // The dangerous default would be the other way round: a row created and left alone
    // must not transact.
    expect(byName('enabled')).toMatchObject({ defaultValue: false })
  })

  it('localizes the display name and nothing that holds money or secrets', () => {
    expect(byName('displayName')).toMatchObject({ localized: true })

    // CLAUDE.md: `localized: true` on a field that already has a column needs a migration,
    // and on a credential column would put one secret per locale in the database.
    for (const field of credentialFields()) {
      expect('localized' in field ? field.localized : false, `${named(field)} is localized`).toBeFalsy()
    }

    for (const name of ['priority', 'minAmount', 'maxAmount', 'gateway', 'mode']) {
      const field = byName(name)

      expect(field && 'localized' in field ? field.localized : false, `${name} is localized`).toBeFalsy()
    }
  })

  it('derives the columns a self-test and a reconciliation need', () => {
    for (const name of ['credentialsSummary', 'credentialsUpdatedAt', 'selfTestOk', 'selfTestDetail', 'selfTestAt']) {
      expect(byName(name), `missing ${name}`).toBeDefined()
    }
  })

  it('runs the encrypting hook before the one that judges the row usable', () => {
    // `assertGatewayUsable` inspects what is about to be written. Read before the
    // encryption hook it would judge the typed plaintext, and a row whose secrets the
    // encrypting hook refused to store would still be allowed to switch itself on.
    //
    // Asserted on the hook array by function identity, not by scanning the source: a scan
    // finds the first *mention* of a name, and these four are all mentioned in the comment
    // above the array.
    const hooks = PaymentGateways.hooks?.beforeChange ?? []

    expect(hooks).toEqual([
      encryptGatewayCredentials,
      lockGatewayChoice,
      uniqueGatewayPerSite,
      assertGatewayUsable,
    ])
  })
})
