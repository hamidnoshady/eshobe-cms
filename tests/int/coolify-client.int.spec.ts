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
  privateKeyUuid: null,
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
