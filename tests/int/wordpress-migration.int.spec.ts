// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { FetchImpl } from '@/lib/wordpress/client'
import {
  createWordPressClient,
  redactSecrets,
  WordPressApiError,
} from '@/lib/wordpress/client'
import { coverageBlockers, coverageMatrix } from '@/lib/wordpress/coverage'
import { discoverWordPress } from '@/lib/wordpress/discovery'
import { buildDryRunReport } from '@/lib/wordpress/dry-run'
import {
  wooMultiLineOrder,
  wooOrderWithTotalMismatch,
  wpGenreTerms,
  wpPortfolioEntry,
  wpTaxonomiesResponse,
  wpTypesResponse,
} from '@/lib/wordpress/fixtures'
import {
  contentHashOf,
  convertWooMoney,
  decimalStringToMinor,
  MappingError,
  mapWooOrderStatus,
  mapWordPressStatus,
  preserveWordPressSlug,
  sourceRecordKey,
  wpRestDateToIso,
} from '@/lib/wordpress/mapping'
import { isPrivateIp, validateSourceBaseUrl, validateSourceBaseUrlSyntax } from '@/lib/wordpress/source-url'

const jsonResponse = (
  body: unknown,
  { headers = {}, status = 200 }: { headers?: Record<string, string>; status?: number } = {},
): Awaited<ReturnType<FetchImpl>> => ({
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

describe('WordPress source URL guard (SSRF)', () => {
  it('accepts a public HTTPS origin and keeps a subdirectory install path', () => {
    expect(validateSourceBaseUrlSyntax('https://example.ir/')).toEqual({
      baseUrl: 'https://example.ir',
      ok: true,
    })
    expect(validateSourceBaseUrlSyntax('https://example.ir/blog/')).toEqual({
      baseUrl: 'https://example.ir/blog',
      ok: true,
    })
  })

  it.each([
    ['http://example.ir', 'NOT_HTTPS'],
    ['https://user:pass@example.ir', 'EMBEDDED_CREDENTIALS'],
    ['https://example.ir:8443', 'NON_STANDARD_PORT'],
    ['https://localhost', 'INTERNAL_HOST'],
    ['https://printer.local', 'INTERNAL_HOST'],
    ['https://127.0.0.1', 'PRIVATE_IP'],
    ['https://10.0.0.5', 'PRIVATE_IP'],
    ['https://[::1]', 'PRIVATE_IP'],
    ['https://8.8.8.8', 'IP_LITERAL'],
    ['not a url', 'INVALID_URL'],
  ])('refuses %s', (input, code) => {
    expect(validateSourceBaseUrlSyntax(input)).toMatchObject({ code, ok: false })
  })

  it('classifies private/reserved IP ranges including v4-mapped v6', () => {
    expect(isPrivateIp('192.168.1.1')).toBe(true)
    expect(isPrivateIp('172.16.0.1')).toBe(true)
    expect(isPrivateIp('172.32.0.1')).toBe(false)
    expect(isPrivateIp('169.254.169.254')).toBe(true) // cloud metadata
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateIp('fd00::1')).toBe(true)
    expect(isPrivateIp('1.1.1.1')).toBe(false)
  })

  it('refuses when DNS resolves the public name to a private address', async () => {
    await expect(
      validateSourceBaseUrl('https://sneaky.example.ir', {
        lookup: async () => [{ address: '93.184.216.34' }, { address: '10.1.2.3' }],
      }),
    ).resolves.toMatchObject({ code: 'DNS_TO_PRIVATE', ok: false })
    await expect(
      validateSourceBaseUrl('https://fine.example.ir', {
        lookup: async () => [{ address: '93.184.216.34' }],
      }),
    ).resolves.toMatchObject({ ok: true })
  })
})

describe('WordPress REST client', () => {
  it('paginates by page number under the base and sends application-password auth unspaced', async () => {
    const seen: { authorization?: string; url: string }[] = []
    const fetchImpl: FetchImpl = async (url, init) => {
      seen.push({ authorization: init.headers.authorization, url })
      const page = new URL(url).searchParams.get('page')
      return jsonResponse(page === '1' ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }], {
        headers: { 'x-wp-totalpages': '2' },
      })
    }
    const client = createWordPressClient({
      applicationPassword: 'abcd efgh ijkl',
      baseUrl: 'https://example.ir',
      fetchImpl,
      perPage: 2,
      sleep: async () => {},
      username: 'admin',
    })

    await expect(client.collect('/wp-json/wp/v2/portfolio')).resolves.toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ])
    expect(seen.map((s) => s.url)).toEqual([
      'https://example.ir/wp-json/wp/v2/portfolio?page=1&per_page=2',
      'https://example.ir/wp-json/wp/v2/portfolio?page=2&per_page=2',
    ])
    expect(seen[0]!.authorization).toBe(
      `Basic ${Buffer.from('admin:abcdefghijkl').toString('base64')}`,
    )
  })

  it('retries 429/5xx with backoff, then succeeds', async () => {
    let calls = 0
    const waits: number[] = []
    const client = createWordPressClient({
      baseUrl: 'https://example.ir',
      fetchImpl: async () => {
        calls += 1
        return calls < 3
          ? jsonResponse({ code: 'busy', message: 'slow down' }, { status: 503 })
          : jsonResponse({ ok: true })
      },
      retryBaseMs: 100,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })

    await expect(client.getJson('/wp-json/')).resolves.toEqual({ ok: true })
    expect(waits).toEqual([100, 200])
  })

  it('surfaces WP errors without ever echoing credentials', async () => {
    const client = createWordPressClient({
      applicationPassword: 'supersecretpassword',
      baseUrl: 'https://example.ir',
      fetchImpl: async () =>
        jsonResponse(
          { code: 'rest_forbidden', message: 'denied for supersecretpassword' },
          { status: 403 },
        ),
      sleep: async () => {},
      username: 'admin',
    })

    const error = await client.getJson('/wp-json/wp/v2/types').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WordPressApiError)
    expect((error as Error).message).not.toContain('supersecretpassword')
    expect((error as Error).message).toContain('[redacted]')
    expect(redactSecrets('Basic abc123== and consumerSecret: xyz')).not.toContain('abc123')
  })

  it('refuses to build a URL outside /wp-json/', async () => {
    const client = createWordPressClient({
      baseUrl: 'https://example.ir',
      fetchImpl: async () => jsonResponse({}),
    })
    await expect(client.getJson('/wp-admin/options.php')).rejects.toMatchObject({
      code: 'BAD_PATH',
    })
  })
})

describe('WordPress discovery + coverage', () => {
  const registryClient = (overrides: Record<string, unknown> = {}) => {
    const routes: Record<string, unknown> = {
      '/wp-json/': { name: 'سایت نمونه', namespaces: ['wp/v2', 'wc/v3'] },
      '/wp-json/wp/v2/taxonomies': wpTaxonomiesResponse(),
      '/wp-json/wp/v2/types': wpTypesResponse(),
      ...overrides,
    }
    return createWordPressClient({
      baseUrl: 'https://example.ir',
      fetchImpl: async (url) => {
        const path = new URL(url).pathname
        const body = routes[path]
        return body === undefined
          ? jsonResponse({ code: 'rest_no_route', message: 'nope' }, { status: 404 })
          : jsonResponse(body)
      },
      sleep: async () => {},
    })
  }

  it('inventories CPTs and taxonomies as separate definitions, Woo included', async () => {
    const inventory = await discoverWordPress(registryClient())
    expect(inventory.hasWooCommerce).toBe(true)
    expect(inventory.postTypes.find((t) => t.slug === 'portfolio')).toMatchObject({
      builtin: false,
      capability: 'custom',
      restBase: 'portfolio',
      taxonomies: ['genre', 'post_tag'],
    })
    expect(inventory.taxonomies.map((t) => t.slug)).toEqual(
      expect.arrayContaining(['category', 'post_tag', 'genre', 'product_cat']),
    )
    expect(inventory.warnings.filter((w) => w.severity === 'blocking')).toEqual([])
  })

  it('never reads an empty registry as "no content" — it blocks with next steps', async () => {
    const inventory = await discoverWordPress(
      registryClient({ '/wp-json/wp/v2/taxonomies': {}, '/wp-json/wp/v2/types': {} }),
    )
    const codes = inventory.warnings.filter((w) => w.severity === 'blocking').map((w) => w.code)
    expect(codes).toContain('CORE_TYPES_MISSING')
    expect(codes).toContain('NO_TAXONOMIES_VISIBLE')
  })

  it('produces a coverage matrix with honest blockers', async () => {
    const inventory = await discoverWordPress(registryClient())
    const rows = coverageMatrix(inventory, {
      plugins: ['elementor', 'woocommerce-subscriptions', 'some-unknown-plugin'],
      woo: { hasVariableProducts: true },
    })
    const byResource = new Map(rows.map((row) => [row.resource, row]))

    expect(byResource.get('post-type:portfolio')?.disposition).toBe('supported')
    expect(byResource.get('taxonomy:genre')?.disposition).toBe('supported')
    expect(byResource.get('post-type:product')?.disposition).toBe('requires-mapping')
    expect(byResource.get('orders')?.disposition).toBe('requires-mapping')
    expect(byResource.get('customers')?.disposition).toBe('requires-mapping')
    expect(byResource.get('plugin:elementor')?.disposition).toBe('archive-only')
    expect(byResource.get('plugin:some-unknown-plugin')?.disposition).toBe('requires-mapping')
    expect(coverageBlockers(rows).length).toBeGreaterThan(0)
  })
})

describe('WordPress mapping primitives', () => {
  it('maps statuses with internals archived and unknowns never public', () => {
    expect(mapWordPressStatus('publish').target).toBe('published')
    expect(mapWordPressStatus('future').target).toBe('scheduled')
    expect(mapWordPressStatus('auto-draft')).toMatchObject({ disposition: 'archive-only', target: null })
    expect(mapWordPressStatus('wc-custom-status').target).toBe('draft')
    expect(mapWooOrderStatus('processing')).toMatchObject({ lossy: true, target: 'paid' })
  })

  it('converts decimal money exactly and refuses precision loss', () => {
    expect(decimalStringToMinor('12.30', 2)).toBe(1230)
    expect(decimalStringToMinor('120000.00', 0)).toBe(120000)
    expect(decimalStringToMinor('-5.5', 2)).toBe(-550)
    expect(() => decimalStringToMinor('12.345', 2)).toThrowError(MappingError)
    expect(() => decimalStringToMinor('12,30', 2)).toThrowError(MappingError)
  })

  it('never converts Rial↔Toman without explicit confirmation', () => {
    const base = { sourceCurrency: 'IRR', sourceDecimals: 0, targetCurrency: 'IRT', value: '660000' }
    expect(() => convertWooMoney(base)).toThrowError(/تأیید صریح/)
    expect(convertWooMoney({ ...base, confirmedRialToToman: true })).toBe(66000)
    expect(() => convertWooMoney({ ...base, confirmedRialToToman: true, value: '660005' })).toThrowError(
      MappingError,
    )
    expect(
      convertWooMoney({ sourceCurrency: 'USD', sourceDecimals: 2, targetCurrency: 'USD', value: '9.99' }),
    ).toBe(999)
    expect(() =>
      convertWooMoney({ sourceCurrency: 'USD', sourceDecimals: 2, targetCurrency: 'EUR', value: '9.99' }),
    ).toThrowError(MappingError)
  })

  it('preserves Persian source slugs verbatim and key order does not change hashes', () => {
    expect(preserveWordPressSlug('%D8%AE%D8%A7%D9%86%D9%87-%D8%AF%D8%B1%DB%8C%D8%A7')).toBe('خانه-دریا')
    expect(() => preserveWordPressSlug('a/b')).toThrowError(MappingError)
    expect(contentHashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(contentHashOf({ b: { d: 3, c: 2 }, a: 1 }))
    expect(
      sourceRecordKey({ installation: 'example.ir', resourceType: 'post-type:portfolio', siteId: 's1', sourceId: 42 }),
    ).toBe('s1|example.ir|post-type%3Aportfolio|42')
  })

  it('prefers the GMT date WP provides', () => {
    const entry = wpPortfolioEntry()
    expect(wpRestDateToIso(entry)).toBe('2024-05-01T06:30:00.000Z')
    expect(wpRestDateToIso(entry, 'modified')).toBe('2024-06-01T05:30:00.000Z')
  })
})

describe('dry-run report accounting', () => {
  it('accounts every sampled record exactly once and reconciles order money', async () => {
    const types = wpTypesResponse()
    const client = createWordPressClient({
      baseUrl: 'https://example.ir',
      fetchImpl: async (url) => {
        const path = new URL(url).pathname
        if (path === '/wp-json/') return jsonResponse({ name: 'x', namespaces: ['wp/v2', 'wc/v3'] })
        if (path.endsWith('/types')) return jsonResponse(types)
        if (path.endsWith('/taxonomies')) return jsonResponse(wpTaxonomiesResponse())
        return jsonResponse({}, { status: 404 })
      },
      sleep: async () => {},
    })
    const inventory = await discoverWordPress(client)
    const coverage = coverageMatrix(inventory)
    const entry = wpPortfolioEntry()
    const seenKey = sourceRecordKey({
      installation: 'example.ir',
      resourceType: 'post-type:portfolio',
      siteId: 'site-1',
      sourceId: 42,
    })

    const report = buildDryRunReport({
      coverage,
      existingHashes: new Map([[seenKey, contentHashOf(entry)]]),
      installation: 'example.ir',
      inventory,
      samples: [
        { records: [entry, { ...wpPortfolioEntry(), id: 43 }], resource: 'post-type:portfolio' },
        { records: wpGenreTerms(), resource: 'taxonomy:genre' },
        { records: [wooMultiLineOrder(), wooOrderWithTotalMismatch()], resource: 'orders' },
        { records: [{ no_id: true }], resource: 'media' },
      ],
      siteId: 'site-1',
      sourceDecimals: 2,
    })

    const portfolio = report.resources.find((r) => r.resource === 'post-type:portfolio')!
    expect(portfolio).toMatchObject({ seen: 2, unchanged: 1, wouldCreate: 1 })
    expect(report.resources.find((r) => r.resource === 'orders')).toMatchObject({
      blocked: 0,
      seen: 2,
      wouldCreate: 2,
    })
    expect(report.resources.find((r) => r.resource === 'media')!.errors).toHaveLength(1)
    for (const resource of report.resources) {
      expect(
        resource.wouldCreate +
          resource.wouldUpdate +
          resource.unchanged +
          resource.blocked +
          resource.archived +
          resource.errors.length,
      ).toBe(resource.seen)
    }
    expect(report.unknownMetaKeysByResource['post-type:portfolio']).toContain('unmapped_plugin_key')
    expect(report.moneyChecks.map((check) => check.ok)).toEqual([true, false])
    expect(report.readyToImport).toBe(false) // the non-reconciling source order stays a blocker
  })

  it('flags a non-reconciling order total when orders are not blocked', () => {
    const report = buildDryRunReport({
      coverage: [
        {
          destination: 'orders',
          disposition: 'requires-mapping',
          label: 'orders',
          reason: 'test',
          resource: 'orders',
        },
      ],
      installation: 'example.ir',
      inventory: {
        hasWooCommerce: true,
        namespaces: [],
        postTypes: [],
        siteName: null,
        taxonomies: [],
        warnings: [],
      },
      samples: [{ records: [wooMultiLineOrder(), wooOrderWithTotalMismatch()], resource: 'orders' }],
      siteId: 'site-1',
      sourceDecimals: 2,
    })
    expect(report.moneyChecks.map((c) => c.ok)).toEqual([true, false])
    expect(report.blockers.join(' ')).toContain('701')
  })
})
