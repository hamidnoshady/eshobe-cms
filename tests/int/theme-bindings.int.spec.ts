import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindingAppName, bindingKeyOf, legacyAppName } from '@/lib/deploy/appIdentity'
import { legacyCaddyEdgeEnabled, resolveDeployMode } from '@/lib/deploy/lane'
import { CoolifyClient, type DeployTarget } from '@/deploy/coolify'

describe('theme binding identity', () => {
  it('app name does not change when site domain changes', () => {
    const siteId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const themeKey = 'my-theme'
    const a = bindingAppName(siteId, themeKey, 'production')
    const b = bindingAppName(siteId, themeKey, 'production')
    expect(a).toBe(b)
    expect(a).toContain('my-theme')
    expect(a).not.toContain('acme.ir')
  })

  it('preview and production bindings use different app names', () => {
    const siteId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(bindingAppName(siteId, 't', 'preview')).not.toBe(bindingAppName(siteId, 't', 'production'))
  })

  it('binding key is stable per site, package and lane', () => {
    expect(bindingKeyOf('s1', 'p1', 'preview')).toBe('s1:p1:preview')
  })

  it('legacy name differs from immutable name when domain was used', () => {
    const legacy = legacyAppName('shop.example.com', 'site-id', 'theme', 'direct')
    const modern = bindingAppName('site-id', 'theme', 'production')
    expect(legacy).not.toBe(modern)
  })
})

describe('lane API migration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('maps domainMode direct to production lane', () => {
    const resolved = resolveDeployMode({ domainMode: 'direct' })
    expect(resolved).toMatchObject({ domainMode: 'direct', lane: 'production' })
  })

  it('rejects new edge when legacy flag is off', () => {
    vi.stubEnv('ESHOBE_LEGACY_CADDY_EDGE', '')
    expect(resolveDeployMode({ domainMode: 'edge' })).toMatchObject({ ok: false })
  })

  it('allows edge when legacy flag is on', () => {
    vi.stubEnv('ESHOBE_LEGACY_CADDY_EDGE', '1')
    expect(resolveDeployMode({ domainMode: 'edge' })).toMatchObject({
      domainMode: 'edge',
      lane: 'production',
    })
  })
})

describe('Coolify scoped application lookup', () => {
  const target: DeployTarget = {
    apiToken: 'test-token',
    baseUrl: 'https://coolify.example.test',
    environmentName: 'production',
    githubAppUuid: null,
    gitSource: 'public',
    id: 'target-1',
    name: 'Test Coolify',
    previewProjectUuid: 'project-a',
    privateKeyUuid: null,
    productionProjectUuid: 'project-b',
    projectUuid: 'project-b',
    serverUuid: 'server-1',
  }

  afterEach(() => vi.unstubAllGlobals())

  it('does not adopt an application from another project', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify([
            { name: 'eshobe-site-theme-production', project_uuid: 'other-project', uuid: 'wrong' },
            {
              name: 'eshobe-site-theme-production',
              project_uuid: 'project-b',
              server_uuid: 'server-1',
              uuid: 'right',
            },
          ]),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        ),
      ),
    )

    const result = await new CoolifyClient(target).findApplicationScoped({
      name: 'eshobe-site-theme-production',
      projectUuid: 'project-b',
      serverUuid: 'server-1',
    })

    expect(result).toEqual({ data: { uuid: 'right' }, ok: true })
  })
})

describe('legacy caddy flag', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to disabled', () => {
    vi.stubEnv('ESHOBE_LEGACY_CADDY_EDGE', '')
    expect(legacyCaddyEdgeEnabled()).toBe(false)
  })

  it('rejects unknown domainMode values instead of defaulting to preview', () => {
    expect(resolveDeployMode({ domainMode: 'whatever' })).toMatchObject({ ok: false })
  })
})
