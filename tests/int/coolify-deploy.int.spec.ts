// @vitest-environment node
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { afterEach, describe, expect, it } from 'vitest'

import type { RecordedRequest, StubScenario } from '../fixtures/coolifyStub'

/**
 * `scripts/coolify-deploy.sh`, against a stand-in Coolify API.
 *
 * The step this replaces was a single `curl -X POST …/restart`, and its failure
 * mode is the reason this file exists: `curl` exits 0 for any response it
 * receives, so a deployment that Coolify queued and then failed — bad image
 * pull, a container that never became healthy, a stale UUID answered with a
 * JSON 404 — published a green checkmark on a deploy that did not happen. Every
 * case below is one way that can go wrong, asserted against a real run of the
 * script rather than a reading of it.
 *
 * The stub also records what the script *sent*, which is how credential
 * handling is pinned: the token must travel in an Authorization header, never
 * in a URL (CI logs and Coolify's own access log both capture URLs).
 *
 * `tests/fixtures/coolifyStub.ts` runs out-of-process on purpose — see its
 * header; `spawnSync` would otherwise starve an in-process listener.
 */

const script = resolve(process.cwd(), 'scripts/coolify-deploy.sh')
const stubEntry = resolve(process.cwd(), 'tests/fixtures/coolifyStub.ts')

type Stub = { port: number; requests: () => Promise<RecordedRequest[]> }

let running: ChildProcessWithoutNullStreams[] = []

const startStub = async (scenario: StubScenario): Promise<Stub> => {
  const child = spawn('node', ['--experimental-strip-types', stubEntry, JSON.stringify(scenario)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  running.push(child)

  const lines = createInterface({ input: child.stdout })
  const queue: string[] = []
  let waiting: ((line: string) => void) | undefined
  lines.on('line', (line) => (waiting ? waiting(line) : queue.push(line)) && (waiting = undefined))

  const readLine = (): Promise<string> =>
    queue.length
      ? Promise.resolve(queue.shift() as string)
      : new Promise((done) => {
          waiting = done
        })

  const stderr: string[] = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  child.on('exit', (code) => {
    if (code) throw new Error(`Coolify stub exited ${code}: ${stderr.join('')}`)
  })

  const { port } = JSON.parse(await readLine()) as { port: number }

  return {
    port,
    requests: async () => {
      child.stdin.end()
      return (JSON.parse(await readLine()) as { requests: RecordedRequest[] }).requests
    },
  }
}

const run = (env: Record<string, string>) =>
  spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      COOLIFY_API_TOKEN: 'test-token',
      COOLIFY_HTTP_TIMEOUT: '5',
      COOLIFY_POLL_INTERVAL: '1',
      COOLIFY_RESOURCE_UUID: 'service-uuid',
      COOLIFY_RETRY_DELAY: '1',
      COOLIFY_TIMEOUT: '20',
      ...env,
    },
    timeout: 60_000,
  })

afterEach(() => {
  for (const child of running) child.kill('SIGKILL')
  running = []
})

describe('required configuration', () => {
  it.each([
    ['COOLIFY_URL', { COOLIFY_RESOURCE_UUID: 'x' }],
    ['COOLIFY_RESOURCE_UUID', { COOLIFY_URL: 'http://127.0.0.1:1' }],
  ])('refuses to run without %s', (missing, env) => {
    // Everything is configuration-driven so nothing about production lives in
    // the workflow file; the price is that a missing value must be a loud,
    // immediate failure rather than a request sent to the wrong place.
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, COOLIFY_API_TOKEN: 'token', ...env },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(missing)
  })

  it('refuses to run without a token instead of sending an anonymous deploy', () => {
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COOLIFY_API_TOKEN: '',
        COOLIFY_RESOURCE_UUID: 'x',
        COOLIFY_URL: 'http://127.0.0.1:1',
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('COOLIFY_API_TOKEN')
  })

  it('rejects an unknown resource kind rather than building a bogus URL', () => {
    const result = run({ COOLIFY_RESOURCE_KIND: 'databases', COOLIFY_URL: 'http://127.0.0.1:1' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('COOLIFY_RESOURCE_KIND')
  })
})

describe('triggering the deploy', () => {
  it('posts the restart with latest=true and the token in a header, not the URL', async () => {
    const stub = await startStub({
      deploy: [{ body: { message: 'Service restaring request queued.' }, status: 200 }],
      health: [404],
    })

    const result = run({
      COOLIFY_HEALTHCHECK_STATUS: '404',
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).toBe(0)
    const [deployRequest] = await stub.requests()
    expect(deployRequest.method).toBe('POST')
    // `latest=true` is what makes Coolify re-pull the tag. Without it the
    // service restarts on the image it already has, and the image just
    // published is never rolled out — the deploy "succeeds" and changes nothing.
    expect(deployRequest.url).toBe('/api/v1/services/service-uuid/restart?latest=true')
    expect(deployRequest.auth).toBe('Bearer test-token')
    // Never in the query string: CI logs, proxy logs and Coolify's own access
    // log would all then capture a deploy-capable credential.
    expect(deployRequest.url).not.toContain('test-token')
  })

  it('addresses an application resource under /applications when asked to', async () => {
    const stub = await startStub({ deploy: [{ status: 200 }], health: [200] })

    const result = run({
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_RESOURCE_KIND: 'applications',
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).toBe(0)
    expect((await stub.requests())[0].url).toContain('/api/v1/applications/service-uuid/restart')
  })

  it('retries a 5xx and succeeds once Coolify recovers', async () => {
    const stub = await startStub({ deploy: [{ status: 502 }, { status: 200 }], health: [200] })

    const result = run({
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).toBe(0)
    expect((await stub.requests()).filter((r) => r.method === 'POST')).toHaveLength(2)
  })

  it.each([401, 403, 404, 422])(
    'fails immediately on HTTP %i without retrying a configuration error',
    async (status) => {
      const stub = await startStub({ deploy: [{ body: { message: 'nope' }, status }] })

      const result = run({ COOLIFY_URL: `http://127.0.0.1:${stub.port}` })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(String(status))
      // A wrong token or a stale UUID answers the same way five times; retrying
      // only buries the one line that says what is actually wrong.
      expect(await stub.requests()).toHaveLength(1)
    },
  )

  it('fails when Coolify is unreachable rather than reporting a deploy', () => {
    // Port 1 on loopback: connection refused, which curl reports as a non-zero
    // exit with http_code 000. The old `curl -sf` also failed here, but only
    // because of `-f`; this pins it independently of that flag.
    const result = run({ COOLIFY_MAX_ATTEMPTS: '2', COOLIFY_URL: 'http://127.0.0.1:1' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('failed')
  })
})

describe('waiting for the deployment to finish', () => {
  it('polls a returned deployment_uuid until it finishes', async () => {
    const stub = await startStub({
      deploy: [{ body: { deployment_uuid: 'dep-1' }, status: 200 }],
      deployments: [
        { body: { status: 'in_progress' }, status: 200 },
        { body: { status: 'finished' }, status: 200 },
      ],
      health: [200],
    })

    const result = run({
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).toBe(0)
    const polls = (await stub.requests()).filter((r) =>
      r.url.startsWith('/api/v1/deployments/dep-1'),
    )
    expect(polls.length).toBeGreaterThanOrEqual(2)
    expect(polls[0].auth).toBe('Bearer test-token')
  })

  it('fails the workflow when the deployment itself fails', async () => {
    const stub = await startStub({
      deploy: [{ body: { deployment_uuid: 'dep-2' }, status: 200 }],
      deployments: [{ body: { status: 'failed' }, status: 200 }],
      // A failed rollout usually leaves the OLD container running and healthy,
      // which is exactly why a health check alone is not enough and the
      // deployment state has to be authoritative when it is available.
      health: [200],
    })

    const result = run({
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('failed')
    expect(result.stderr).toContain('NOT updated')
  })

  it('fails when a cancelled deployment leaves the old image in place', async () => {
    const stub = await startStub({
      deploy: [{ body: { deployment_uuid: 'dep-3' }, status: 200 }],
      deployments: [{ body: { status: 'cancelled_by_user' }, status: 200 }],
      health: [200],
    })

    const result = run({
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('cancelled_by_user')
  })

  it('times out instead of hanging on a deployment that never leaves the queue', async () => {
    const stub = await startStub({
      deploy: [{ body: { deployment_uuid: 'dep-4' }, status: 200 }],
      deployments: [{ body: { status: 'queued' }, status: 200 }],
    })

    const result = run({ COOLIFY_TIMEOUT: '3', COOLIFY_URL: `http://127.0.0.1:${stub.port}` })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('timed out')
  })

  it('falls back to the health check when the service API returns no handle', async () => {
    // Coolify's service-restart endpoint does not return a deployment_uuid
    // (coollabsio/coolify#9755), so on this deployment the health check is the
    // only available proof — and the script must still produce one.
    const stub = await startStub({
      deploy: [{ body: { message: 'Service restaring request queued.' }, status: 200 }],
      health: [502, 502, 404],
    })

    const result = run({
      COOLIFY_HEALTHCHECK_STATUS: '404',
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).toBe(0)
    const health = (await stub.requests()).filter((r) => r.url.startsWith('/health'))
    expect(health.length).toBeGreaterThanOrEqual(3)
  })
})

describe('verifying the container really serves', () => {
  it('fails when the app never becomes healthy after a finished deployment', async () => {
    const stub = await startStub({
      deploy: [{ body: { deployment_uuid: 'dep-5' }, status: 200 }],
      deployments: [{ body: { status: 'finished' }, status: 200 }],
      health: [502],
    })

    const result = run({
      COOLIFY_HEALTHCHECK_STATUS: '404',
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_TIMEOUT: '4',
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('timed out')
    expect(result.stderr).toContain('502')
  })

  it("treats the domain-check endpoint's deliberate 404 as healthy, and a 200 as not", async () => {
    // docker-compose.srv1.yml's own healthcheck expects 404 from
    // /api/domain-check for an unknown domain — a 200 there would mean the
    // endpoint authorised a host it should not. The external check has to agree
    // with the container's, or CI and Docker disagree about "healthy".
    const stub = await startStub({ deploy: [{ status: 200 }], health: [200] })

    const result = run({
      COOLIFY_HEALTHCHECK_STATUS: '404',
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_TIMEOUT: '3',
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('expected 404')
  })

  it('accepts any of several expected statuses', async () => {
    const stub = await startStub({ deploy: [{ status: 200 }], health: [404] })

    const result = run({
      COOLIFY_HEALTHCHECK_STATUS: '200,404',
      COOLIFY_HEALTHCHECK_URL: `http://127.0.0.1:${stub.port}/health`,
      COOLIFY_URL: `http://127.0.0.1:${stub.port}`,
    })

    expect(result.status).toBe(0)
  })

  it('refuses to report success when there is nothing at all to verify with', async () => {
    // No deployment handle and no health URL means the script cannot tell a
    // rollout from a no-op. Reporting green there is the exact bug being fixed,
    // so an unverifiable deploy is a failure, not a pass.
    const stub = await startStub({ deploy: [{ body: { message: 'queued' }, status: 200 }] })

    const result = run({ COOLIFY_URL: `http://127.0.0.1:${stub.port}` })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('could not be verified')
  })
})

describe('the script itself', () => {
  const source = readFileSync(script, 'utf8')

  it('aborts on the first error and on an unset variable', () => {
    // Without `set -u` a mistyped variable silently becomes an empty string,
    // and a deploy script that builds `…//restart` from an empty UUID is worse
    // than one that fails.
    expect(source).toMatch(/set -euo pipefail/)
  })

  it('never writes the token into a URL or echoes it', () => {
    expect(source).not.toMatch(/token=\$/)
    expect(source).not.toMatch(/echo[^\n]*\$token/)
    expect(source).not.toMatch(/log[^\n]*\$token/)
  })
})
