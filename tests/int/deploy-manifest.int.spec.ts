import { describe, expect, it } from 'vitest'

import {
  MAX_ENV_VALUE_LENGTH,
  PLATFORM_ENV_KEYS,
  isSafeGitRef,
  manifestKey,
  parseRepository,
  parseThemeManifest,
  parseThemeManifestText,
  validateTenantEnv,
  type ThemeManifest,
} from '@/lib/deploy/manifest'
import {
  canTransition,
  holdsApplication,
  isDeploymentStatus,
  isPending,
  DEPLOYMENT_STATUSES,
} from '@/lib/deploy/status'
import { coolifyAppName, normalizeBaseUrl, scrubDetail } from '@/deploy/coolify'

/**
 * The pure half of the deployable-theme feature — no Payload, no database.
 *
 * `eshobe.theme.json` arrives from a third-party repository and every field in it is
 * configuration the platform will act on: a build command it runs, an environment
 * variable it writes, a contract version it trusts. So the parser is an allowlist and
 * this spec is mostly about what it *refuses*.
 */

const valid = {
  build: {
    buildCommand: 'pnpm build',
    healthCheckPath: '/api/health',
    installCommand: 'pnpm i --frozen-lockfile',
    pack: 'nixpacks',
    port: 3000,
    startCommand: 'pnpm start',
  },
  contractVersion: 1,
  env: [{ key: 'MAP_API_KEY', labelFa: 'کلید نقشه', required: false, secret: true, source: 'tenant' }],
  key: 'bazaar-store',
  name: 'Bazaar Store',
  siteTypes: ['store'],
}

const parse = (input: unknown, platformVersion = 1) => parseThemeManifest(input, platformVersion)

const manifestOf = (input: unknown): ThemeManifest => {
  const result = parse(input)
  if (!result.ok) throw new Error(result.errors.join(' '))
  return result.manifest
}

describe('parseThemeManifest', () => {
  it('accepts a well-formed manifest and projects its build settings', () => {
    const manifest = manifestOf(valid)

    expect(manifest.key).toBe('bazaar-store')
    expect(manifest.build.buildPack).toBe('nixpacks')
    expect(manifest.build.port).toBe(3000)
    expect(manifest.siteTypes).toEqual(['store'])
    // Defaults that must exist even when the manifest is silent, because the deploy
    // job reads them unconditionally.
    expect(manifest.build.baseDirectory).toBe('/')
    expect(manifest.proxiesApi).toBe(false)
  })

  it('refuses a theme written against a newer contract than this deployment serves', () => {
    // The whole reason `contractVersion` exists. A theme reading fields `/api/site`
    // does not emit yet fails as a blank storefront on a customer's domain — the
    // refusal has to happen at registration, where it is cheap.
    const result = parse({ ...valid, contractVersion: 2 }, 1)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toContain('نسخهٔ قرارداد ۲'.replace('۲', '2'))
  })

  it('accepts a theme written against an older contract', () => {
    expect(parse({ ...valid, contractVersion: 1 }, 3).ok).toBe(true)
  })

  it.each(PLATFORM_ENV_KEYS)(
    'refuses %s as a tenant-supplied variable',
    (key) => {
      // The refusal that matters most: a theme must not be able to nominate the
      // customer — or itself — as the author of the CMS URL or the API key it
      // authenticates with.
      const result = parse({
        ...valid,
        env: [{ key, source: 'tenant' }],
      })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors.join(' ')).toContain(key)
    },
  )

  it('allows a platform variable to be declared, since declaring is not supplying', () => {
    const manifest = manifestOf({
      ...valid,
      env: [{ key: 'ESHOBE_API_KEY', source: 'platform' }],
    })

    expect(manifest.env[0]!.source).toBe('platform')
  })

  it('refuses an unknown build pack rather than passing it to Coolify', () => {
    const result = parse({ ...valid, build: { ...valid.build, pack: 'make' } })

    expect(result.ok).toBe(false)
  })

  it('refuses a site type that no site can have', () => {
    const result = parse({ ...valid, siteTypes: ['restaurant'] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toContain('restaurant')
  })

  it('refuses a port outside the valid range', () => {
    expect(parse({ ...valid, build: { ...valid.build, port: 0 } }).ok).toBe(false)
    expect(parse({ ...valid, build: { ...valid.build, port: 70000 } }).ok).toBe(false)
  })

  it('refuses a duplicated or malformed env key', () => {
    expect(
      parse({ ...valid, env: [{ key: 'A_KEY' }, { key: 'A_KEY' }] }).ok,
    ).toBe(false)
    expect(parse({ ...valid, env: [{ key: 'lowercase' }] }).ok).toBe(false)
  })

  it('refuses a non-https preview URL', () => {
    expect(parse({ ...valid, preview: 'http://example.com/a.png' }).ok).toBe(false)
  })

  it('caps the manifest size before JSON.parse sees it', () => {
    const huge = JSON.stringify({ ...valid, padding: 'x'.repeat(100_000) })

    const result = parseThemeManifestText(huge, 1)

    expect(result.ok).toBe(false)
  })

  it('reports unreadable JSON as a refusal, not a throw', () => {
    const result = parseThemeManifestText('{ not json', 1)

    expect(result.ok).toBe(false)
  })

  it('slugifies a key from the name when none is given', () => {
    expect(manifestKey('Bazaar Store!')).toBe('bazaar-store')
    expect(manifestOf({ ...valid, key: undefined }).key).toBe('bazaar-store')
  })
})

describe('validateTenantEnv', () => {
  const manifest = manifestOf({
    ...valid,
    env: [
      { key: 'MAP_API_KEY', required: true, secret: true, source: 'tenant' },
      { key: 'ANALYTICS_ID', required: false, source: 'tenant' },
      { key: 'ESHOBE_CMS_URL', source: 'platform' },
    ],
  })

  it('keeps declared values and drops undeclared ones', () => {
    const result = validateTenantEnv(manifest, {
      ANALYTICS_ID: 'G-1234',
      MAP_API_KEY: 'abc',
      SOMETHING_ELSE: 'x',
    })

    expect(result.values).toEqual({ ANALYTICS_ID: 'G-1234', MAP_API_KEY: 'abc' })
    expect(result.errors.join(' ')).toContain('SOMETHING_ELSE')
  })

  it('never accepts a value for a platform-owned variable', () => {
    // Belt to `buildEnvironment`'s braces: the platform values are also written last,
    // so even if this refusal were relaxed the tenant could not win.
    const result = validateTenantEnv(manifest, { ESHOBE_CMS_URL: 'https://evil.example' })

    expect(result.values).toEqual({})
    expect(result.errors.length).toBe(2) // undeclared-as-tenant, plus the missing required one
  })

  it('requires a required variable', () => {
    const result = validateTenantEnv(manifest, { ANALYTICS_ID: 'G-1' })

    expect(result.errors.join(' ')).toContain('MAP_API_KEY')
  })

  it('caps a value length — this string is heading into a build environment', () => {
    const result = validateTenantEnv(manifest, { MAP_API_KEY: 'x'.repeat(MAX_ENV_VALUE_LENGTH + 1) })

    expect(result.values.MAP_API_KEY).toBeUndefined()
    expect(result.errors.join(' ')).toContain('MAP_API_KEY')
  })
})

describe('parseRepository', () => {
  it('reduces the forms an operator actually pastes', () => {
    expect(parseRepository('hamidnoshady/eshobe-cms')).toEqual({
      name: 'eshobe-cms',
      owner: 'hamidnoshady',
    })
    expect(parseRepository('https://github.com/hamidnoshady/eshobe-cms')).toEqual({
      name: 'eshobe-cms',
      owner: 'hamidnoshady',
    })
    expect(parseRepository('git@github.com:hamidnoshady/eshobe-cms.git')).toEqual({
      name: 'eshobe-cms',
      owner: 'hamidnoshady',
    })
  })

  it('refuses anything that is not owner/name', () => {
    expect(parseRepository('../../etc/passwd')).toBeNull()
    expect(parseRepository('owner/name/extra')).toBeNull()
    expect(parseRepository('')).toBeNull()
  })
})

describe('isSafeGitRef', () => {
  it('accepts branches, tags and shas', () => {
    expect(isSafeGitRef('main')).toBe(true)
    expect(isSafeGitRef('v1.3.0')).toBe(true)
    expect(isSafeGitRef('release/2026-09')).toBe(true)
  })

  it('refuses a ref that could be read as an option or a traversal', () => {
    // This string is handed to a clone. `--upload-pack=` is the classic.
    expect(isSafeGitRef('--upload-pack=sh')).toBe(false)
    expect(isSafeGitRef('a/../b')).toBe(false)
    expect(isSafeGitRef('branch name')).toBe(false)
    expect(isSafeGitRef('x'.repeat(200))).toBe(false)
  })
})

describe('deployment status machine', () => {
  it('starts at queued from nothing', () => {
    expect(canTransition(undefined, 'queued')).toBe(true)
    expect(canTransition(undefined, 'live')).toBe(false)
  })

  it('treats removed as terminal', () => {
    // A row that could leave `removed` would be a row claiming to run an application
    // that has been deleted. A new deploy is a new row.
    for (const status of DEPLOYMENT_STATUSES) {
      if (status === 'removed') continue
      expect(canTransition('removed', status)).toBe(false)
    }
  })

  it('lets a failed deployment be retried but not promoted', () => {
    expect(canTransition('failed', 'queued')).toBe(true)
    expect(canTransition('failed', 'live')).toBe(false)
  })

  it('refuses to jump straight from queued to live', () => {
    expect(canTransition('queued', 'live')).toBe(false)
  })

  it('knows which states still hold a Coolify application', () => {
    expect(holdsApplication('live')).toBe(true)
    expect(holdsApplication('stopped')).toBe(true)
    expect(holdsApplication('queued')).toBe(false)
    expect(holdsApplication('removed')).toBe(false)
  })

  it('knows which states a poller should keep watching', () => {
    expect(isPending('building')).toBe(true)
    expect(isPending('live')).toBe(false)
    expect(isDeploymentStatus('nonsense')).toBe(false)
  })
})

describe('coolify client helpers', () => {
  it('refuses a plaintext base URL off localhost', () => {
    // This request carries a token that can start and stop every customer's
    // storefront. Sending it in clear must not be one typed character away.
    expect(normalizeBaseUrl('http://coolify.example.com')).toBeNull()
    expect(normalizeBaseUrl('https://coolify.example.com/')).toBe('https://coolify.example.com')
    expect(normalizeBaseUrl('http://localhost:8000')).toBe('http://localhost:8000')
    expect(normalizeBaseUrl('not a url')).toBeNull()
  })

  it('builds a deterministic container name so a lost create can be reconciled', () => {
    expect(coolifyAppName('acme.ir', 'bazaar-store')).toBe('acme-ir-bazaar-store')
    expect(coolifyAppName('acme.ir', 'bazaar-store')).toBe(coolifyAppName('acme.ir', 'bazaar-store'))
  })

  it('scrubs credentials out of anything Coolify echoes back', () => {
    // Coolify's validation errors echo the request body, and that body contained a
    // freshly minted site key on its way to an admin screen and an audit row.
    const detail = scrubDetail(
      'invalid: {"ESHOBE_API_KEY":"eshobe_live_deadbeefcafe","authorization":"Bearer tok_123"}',
    )

    expect(detail).not.toContain('eshobe_live_deadbeefcafe')
    expect(detail).not.toContain('tok_123')
    expect(detail).toContain('[redacted]')
  })

  it('scrubs a revalidation secret too', () => {
    expect(scrubDetail('esrv_abc123def456')).not.toContain('esrv_abc123def456')
  })
})
