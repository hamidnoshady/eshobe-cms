import { createHmac, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  TOROB_API_VERSION,
  TOROB_PAGE_SIZE,
  TOROB_SORTS,
  parseTorobRequest,
  torobCursorResponse,
  torobErrorBody,
  torobMaxPages,
  torobPageResponse,
  torobPricePair,
} from '@/lib/torob/contract'
import { torobAuthHeaders, torobPublicKeyPem, verifyTorobToken } from '@/lib/torob/auth'
import { torobToman } from '@/lib/torob/feed'
import { DEFAULT_TOROB_ENROLLMENT, parseTorobEnrollment, torobEnrollmentServes } from '@/lib/torob/enrollment'

/**
 * Issue #183 — the shared Torob Product API v3 contract fixtures.
 *
 * The JSON cases under `tests/fixtures/torob-product-api-v3` are the same cases the
 * Biza Miz platform runtime asserts (see the fixture README for provenance). This file
 * runs them against the CMS implementation so the two runtimes cannot drift.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/torob-product-api-v3', name), 'utf8'))

describe('request contract (shared fixtures)', () => {
  const cases = fixture('request-cases.json')

  for (const { body, mode } of cases.valid) {
    it(`accepts ${mode}`, () => {
      const parsed = parseTorobRequest(body)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.request.mode).toBe(mode)
    })
  }

  for (const { body, error, message } of cases.invalid) {
    it(`rejects ${error} with the exact sentence`, () => {
      const parsed = parseTorobRequest(body)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(torobErrorBody(parsed.error)).toEqual({ error: message })
    })
  }

  it('never defaults an empty body to page 1', () => {
    expect(parseTorobRequest({})).toEqual({ ok: false, error: 'empty_request' })
  })

  it('ignores unknown keys but still requires exactly one mode', () => {
    expect(parseTorobRequest({ page: 1, sort: 'date_added_desc', limit: 50 })).toMatchObject({ ok: true })
    expect(parseTorobRequest({ page: 1, cursor: null, sort: 'product_id_desc' })).toMatchObject({
      ok: false,
      error: 'multiple_modes',
    })
  })
})

describe('price contract (shared fixtures)', () => {
  const cases = fixture('price-cases.json')

  for (const { amount, currency, toman } of cases.valid) {
    it(`converts ${amount} ${currency} to ${toman} Toman`, () => {
      expect(torobToman(amount, currency)).toBe(toman)
    })
  }

  for (const { amount, currency, reason } of cases.invalid) {
    it(`refuses ${amount} ${currency} (${reason})`, () => {
      expect(torobToman(amount, currency)).toBeNull()
    })
  }

  for (const { available, toman, expected } of cases.pairs) {
    it(`pairs availability ${available} with the right price`, () => {
      expect(torobPricePair(available, toman)).toEqual(expected)
    })
  }
})

describe('response envelope (shared fixtures)', () => {
  const cases = fixture('feed-cases.json')

  it('names the version and page size', () => {
    expect(TOROB_API_VERSION).toBe(cases.apiVersion)
    expect(TOROB_PAGE_SIZE).toBe(cases.pageSize)
    expect(TOROB_SORTS).toEqual(['date_added_desc', 'date_updated_desc', 'product_id_desc'])
  })

  for (const { total, maxPages } of cases.maxPages) {
    it(`counts ${total} products as ${maxPages} pages`, () => {
      expect(torobMaxPages(total)).toBe(maxPages)
    })
  }

  it('wraps a numbered page with current_page and a null cursor', () => {
    const response = torobPageResponse({ page: 2, products: [], total: 150 })
    expect(response).toEqual({
      api_version: 'torob_api_v3',
      current_page: 2,
      total: 150,
      max_pages: 2,
      next_cursor: null,
      products: [],
    })
  })

  it('omits current_page in cursor mode', () => {
    const response = torobCursorResponse({ nextCursor: 'abc', products: [], total: 1 })
    expect('current_page' in response).toBe(false)
    expect(response.next_cursor).toBe('abc')
  })
})

/** Sign a real Ed25519 JWT with Node crypto — no stubbed verifier. */
const pair = generateKeyPairSync('ed25519')
const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const otherPair = generateKeyPairSync('ed25519')

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

function mint(options: {
  alg?: string
  aud?: string | string[] | null
  exp?: number
  nbf?: number
  key?: ReturnType<typeof createPrivateKey>
} = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: options.alg ?? 'EdDSA', typ: 'JWT', v: 1 })
  const claims: Record<string, unknown> = {
    exp: options.exp ?? now + 300,
    nbf: options.nbf ?? now - 5,
    iat: now,
  }
  if (options.aud !== null) claims.aud = options.aud ?? 'shop.example.com'
  const payload = b64(claims)
  const signingInput = `${header}.${payload}`
  if ((options.alg ?? 'EdDSA') === 'HS256') {
    const signature = createHmac('sha256', 'secret').update(signingInput).digest('base64url')
    return `${signingInput}.${signature}`
  }
  const signature = cryptoSign(null, Buffer.from(signingInput), options.key ?? pair.privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}

const check = (token: string | null, overrides: { tokenVersion?: string | null; expectedHost?: string; publicKeyPem?: string } = {}) =>
  verifyTorobToken({
    token,
    tokenVersion: overrides.tokenVersion === undefined ? '1' : overrides.tokenVersion,
    expectedHost: overrides.expectedHost ?? 'shop.example.com',
    publicKeyPem: overrides.publicKeyPem ?? publicKeyPem,
  })

describe('auth contract (shared fixtures)', () => {
  const cases = fixture('auth-cases.json')

  for (const aud of cases.validAudiences) {
    it(`accepts audience ${aud}`, async () => {
      expect(await check(mint({ aud }))).toMatchObject({ ok: true, audience: 'shop.example.com' })
    })
  }

  it('rejects a token minted for another shop', async () => {
    expect(await check(mint({ aud: 'other-shop.example.com' }))).toEqual({ ok: false, reason: 'audience_mismatch' })
  })

  it('rejects a token with no audience', async () => {
    expect(await check(mint({ aud: null }))).toEqual({ ok: false, reason: 'audience_mismatch' })
  })

  it('rejects missing token and version headers', async () => {
    expect(await check(null)).toEqual({ ok: false, reason: 'missing_token' })
    expect(await check('   ')).toEqual({ ok: false, reason: 'missing_token' })
    expect(await check(mint(), { tokenVersion: null })).toEqual({ ok: false, reason: 'missing_token_version' })
    expect(await check(mint(), { tokenVersion: '2' })).toEqual({ ok: false, reason: 'unsupported_token_version' })
  })

  it('rejects expired and not-yet-valid tokens', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await check(mint({ exp: now - 10 }))).toEqual({ ok: false, reason: 'expired' })
    expect(await check(mint({ nbf: now + 60 }))).toEqual({ ok: false, reason: 'not_yet_valid' })
  })

  it('rejects a token signed by anyone but Torob', async () => {
    expect(await check(mint({ key: otherPair.privateKey }))).toEqual({ ok: false, reason: 'invalid_token' })
    expect(await check('not-a-token')).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('rejects a symmetric algorithm downgrade', async () => {
    expect(await check(mint({ alg: 'HS256' }))).toEqual({ ok: false, reason: 'wrong_algorithm' })
  })

  it('rejects a token without exp or nbf', async () => {
    const header = b64({ alg: 'EdDSA', typ: 'JWT' })
    const payload = b64({ aud: 'shop.example.com' })
    const input = `${header}.${payload}`
    const signature = cryptoSign(null, Buffer.from(input), pair.privateKey).toString('base64url')
    expect(await check(`${input}.${signature}`)).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('reads the two headers case-insensitively', () => {
    expect(torobAuthHeaders(new Headers({ 'X-Torob-Token': 'abc', 'X-Torob-Token-Version': '1' }))).toEqual({
      token: 'abc',
      tokenVersion: '1',
    })
    expect(torobAuthHeaders(new Headers({ 'x-torob-token': 'abc' }))).toEqual({ token: 'abc', tokenVersion: null })
  })

  it('accepts a bare base64 key body or a full PEM, and falls back to Torob’s key', () => {
    const documented = torobPublicKeyPem({})
    expect(documented).toContain('BEGIN PUBLIC KEY')
    const body = documented.split('\n')[1]!
    expect(torobPublicKeyPem({ TOROB_API_PUBLIC_KEY: body })).toBe(documented)
    expect(torobPublicKeyPem({ TOROB_API_PUBLIC_KEY: documented })).toBe(documented)
  })

  it('fails closed when the configured key is not usable', async () => {
    expect(await check(mint(), { publicKeyPem: 'garbage' })).toEqual({ ok: false, reason: 'invalid_token' })
  })

  // Keep the fixture list honest: every named case has a dedicated assertion above.
  it('covers every fixture case', () => {
    expect(cases.invalid.map((entry: { case: string }) => entry.case).sort()).toEqual(
      [
        'expired',
        'hs256',
        'missing_token',
        'missing_token_version',
        'no_audience',
        'not_a_jwt',
        'not_yet_valid',
        'other_audience',
        'unsupported_token_version',
        'wrong_key',
      ].sort(),
    )
  })
})

describe('enrollment gate', () => {
  const store = { status: 'active', type: 'store' }

  it('serves only a connected, authorized, enabled store', () => {
    expect(
      torobEnrollmentServes({ ...store, torob: { connected: true, enabled: true, authorizationState: 'authorized' } }),
    ).toBe(true)
  })

  it.each([
    { connected: false, enabled: true, authorizationState: 'authorized' },
    { connected: true, enabled: false, authorizationState: 'authorized' },
    { connected: true, enabled: true, authorizationState: 'not_authorized' },
    { connected: true, enabled: true, authorizationState: 'pending_approval' },
    { connected: true, enabled: true, authorizationState: 'revoked' },
  ])('refuses %j', (torob) => {
    expect(torobEnrollmentServes({ ...store, torob })).toBe(false)
  })

  it('refuses a suspended or non-store site even when enrolled', () => {
    const torob = { connected: true, enabled: true, authorizationState: 'authorized' }
    expect(torobEnrollmentServes({ ...store, status: 'suspended', torob })).toBe(false)
    expect(torobEnrollmentServes({ ...store, type: 'business', torob })).toBe(false)
  })

  it('refuses a site with no enrollment at all', () => {
    expect(torobEnrollmentServes(store)).toBe(false)
    expect(torobEnrollmentServes(null)).toBe(false)
  })

  it('defaults to fail-closed and validates a full-state sync', () => {
    expect(DEFAULT_TOROB_ENROLLMENT.authorizationState).toBe('not_authorized')
    expect(parseTorobEnrollment({ connected: true, enabled: true, authorizationState: 'authorized', shopId: 's1' })).toMatchObject({
      ok: true,
      value: { connected: true, enabled: true, authorizationState: 'authorized', shopId: 's1' },
    })
    expect(parseTorobEnrollment({ connected: true }).ok).toBe(false)
    expect(parseTorobEnrollment({ connected: true, enabled: true, authorizationState: 'maybe' }).ok).toBe(false)
    expect(parseTorobEnrollment({ connected: true, enabled: true, authorizationState: 'authorized', surprise: 1 }).ok).toBe(false)
  })
})

describe('reserved page path', () => {
  it('refuses a CMS page at the crawler endpoint path', async () => {
    const { reservedPageSlug } = await import('@/hooks/reservedPageSlug')
    await expect(
      reservedPageSlug({
        data: { slug: 'torob/v1/products' },
        originalDoc: {},
        req: { t: (key: string) => key } as never,
      } as never),
    ).rejects.toThrow()
  })
})
