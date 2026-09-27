import { afterEach, describe, expect, it, vi } from 'vitest'

import { CoolifyClient, type DeployTarget } from '@/deploy/coolify'

const target: DeployTarget = {
  apiToken: 'test-token',
  baseUrl: 'https://coolify.example.test',
  environmentName: 'production',
  githubAppUuid: null,
  gitSource: 'public',
  id: 'target-1',
  name: 'Test Coolify',
  previewProjectUuid: 'project-1',
  privateKeyUuid: null,
  productionProjectUuid: 'project-1',
  projectUuid: 'project-1',
  serverUuid: 'server-1',
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  })

afterEach(() => vi.unstubAllGlobals())

describe('Coolify action request contract', () => {
  it('creates a public immutable image application without a mutable tag', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ uuid: 'application-1' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await new CoolifyClient(target).createApplication({
      source: {
        type: 'registry-image',
        image: 'ghcr.io/owner/theme',
        digest: `sha256:${'a'.repeat(64)}`,
      },
      domains: ['https://preview.example.test'],
      healthCheckPath: '/health',
      name: 'theme',
      port: 3000,
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://coolify.example.test/api/v1/applications/dockerimage')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      docker_registry_image_name: `ghcr.io/owner/theme@sha256:${'a'.repeat(64)}`,
      docker_registry_image_tag: '',
      environment_name: 'production',
      project_uuid: 'project-1',
      server_uuid: 'server-1',
    })
  })

  it('passes only a Coolify registry credential reference for private images', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ uuid: 'application-1' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await new CoolifyClient(target).createApplication({
      source: {
        type: 'registry-image',
        image: 'ghcr.io/owner/theme',
        digest: `sha256:${'a'.repeat(64)}`,
        registryCredentialUuid: 'registry-1',
      },
      domains: [],
      healthCheckPath: null,
      name: 'theme',
      port: 3000,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      docker_registry_uuid: 'registry-1',
    })
  })

  it('starts deployments with POST and the application UUID in JSON', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ deployments: [{ deployment_uuid: 'deployment-1' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await new CoolifyClient(target).deploy('application-1')

    expect(result).toEqual({ data: { deploymentUuid: 'deployment-1' }, ok: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://coolify.example.test/api/v1/deploy')
    expect(init).toMatchObject({
      body: JSON.stringify({ force: false, uuid: 'application-1' }),
      method: 'POST',
    })
  })

  it('rejects a successful deploy response that cannot be polled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ deployments: [] })),
    )

    const result = await new CoolifyClient(target).deploy('application-1')

    expect(result).toMatchObject({
      message: 'Coolify شناسهٔ استقرار را برنگرداند.',
      ok: false,
      status: 502,
    })
  })

  it('uses POST for stop lifecycle actions too', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ message: 'queued' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await new CoolifyClient(target).stop('application-1')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://coolify.example.test/api/v1/applications/application-1/stop')
    expect(init).toMatchObject({ method: 'POST' })
  })
})
