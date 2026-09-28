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
      // `localhost` resolves to ::1 on IPv6-first images and the container is
      // declared unhealthy; the probe host is pinned to IPv4 loopback instead.
      health_check_host: '127.0.0.1',
      health_check_path: '/health',
      health_check_port: '3000',
    })
  })

  it('re-points a registry application with only PATCH-accepted fields', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ uuid: 'application-1' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await new CoolifyClient(target).repointApplication('application-1', {
      domains: 'https://preview.example.test',
      healthCheckPath: '/api/health',
      port: 3000,
      source: {
        type: 'registry-image',
        image: 'ghcr.io/owner/theme',
        digest: `sha256:${'a'.repeat(64)}`,
      },
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://coolify.example.test/api/v1/applications/application-1')
    expect(init?.method).toBe('PATCH')
    // The digest in the stored shape Coolify's own create produces: the bare
    // repository plus the `@sha256` marker in the name column, the bare hash in
    // the tag column. The full `image@sha256:hash` reference is a create-only
    // wire format — on PATCH it is `docker_registry_image_name is invalid`.
    expect(JSON.parse(String(init?.body))).toMatchObject({
      docker_registry_image_name: 'ghcr.io/owner/theme@sha256',
      docker_registry_image_tag: 'a'.repeat(64),
      domains: 'https://preview.example.test',
      ports_exposes: '3000',
      health_check_enabled: true,
      health_check_path: '/api/health',
      health_check_port: '3000',
      health_check_host: '127.0.0.1',
    })
    // Coolify's PATCH allowlist rejects every placement and credential field the
    // create routes accept, with `Validation failed` + `This field is not allowed`.
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    for (const forbidden of [
      'project_uuid',
      'server_uuid',
      'environment_name',
      'environment_uuid',
      'destination_uuid',
      'docker_registry_uuid',
      'github_app_uuid',
      'private_key_uuid',
    ]) {
      expect(body, forbidden).not.toHaveProperty(forbidden)
    }
  })

  it('re-points a git application without the create-only source fields', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ uuid: 'application-1' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await new CoolifyClient(target).repointApplication('application-1', {
      domains: 'https://preview.example.test',
      healthCheckPath: null,
      port: 3000,
      source: {
        type: 'git',
        repository: 'https://github.com/owner/theme',
        branch: 'main',
        commitSha: null,
        buildPack: 'nixpacks',
        baseDirectory: '/',
        buildCommand: 'pnpm build',
        dockerfileLocation: null,
        installCommand: 'pnpm install',
        publishDirectory: null,
        startCommand: 'pnpm start',
      },
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      git_repository: 'https://github.com/owner/theme',
      git_branch: 'main',
      git_commit_sha: 'HEAD',
      build_pack: 'nixpacks',
      health_check_enabled: false,
    })
    // A git source's access method (GitHub App, deploy key) is chosen at create;
    // PATCH rejects `github_app_uuid` and `private_key_uuid` outright.
    expect(body).not.toHaveProperty('github_app_uuid')
    expect(body).not.toHaveProperty('private_key_uuid')
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
