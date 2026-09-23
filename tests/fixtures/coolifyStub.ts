/**
 * A stand-in Coolify API for `tests/int/coolify-deploy.int.spec.ts`.
 *
 * It runs as its own process, started by the spec with `spawn`, because the
 * thing under test is a bash script invoked with `spawnSync`: that call blocks
 * the Node event loop for its whole duration, so a server listening inside the
 * test process would accept the connection and never answer it. Every request
 * would time out and every assertion would be about curl's timeout rather than
 * the script's behaviour.
 *
 * Protocol: the scenario arrives as JSON in argv[2], the chosen port is printed
 * as one JSON line on stdout at startup, and the recorded requests are printed
 * as a final JSON line when the parent closes stdin.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type StubResponse = { body?: unknown; status: number }

export type StubScenario = {
  /** Responses for POST /api/v1/<kind>/<uuid>/restart, in order; the last repeats. */
  deploy: StubResponse[]
  /** Responses for GET /api/v1/deployments/<uuid>, in order; the last repeats. */
  deployments?: StubResponse[]
  /** Status codes for the health URL, in order; the last repeats. */
  health?: number[]
}

export type RecordedRequest = { auth: string | null; method: string; url: string }

const scenario: StubScenario = JSON.parse(process.argv[2] ?? '{"deploy":[]}')

const requests: RecordedRequest[] = []
const deploy = [...scenario.deploy]
const deployments = [...(scenario.deployments ?? [])]
const health = [...(scenario.health ?? [])]

/** Shift while more than one remains, so the last entry becomes the steady state. */
const next = <T>(queue: T[]): T | undefined => (queue.length > 1 ? queue.shift() : queue[0])

const server = createServer((req, res) => {
  requests.push({
    auth: req.headers.authorization ?? null,
    method: req.method ?? '',
    url: req.url ?? '',
  })

  if (req.url?.startsWith('/health')) {
    res.writeHead(next(health) ?? 200)
    res.end('')
    return
  }

  const response = req.url?.startsWith('/api/v1/deployments/')
    ? (next(deployments) ?? { body: { message: 'Resource not found.' }, status: 404 })
    : (next(deploy) ?? { body: {}, status: 200 })

  res.writeHead(response.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(response.body ?? {}))
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`)
})

// The parent closes stdin when it wants the recording back; exiting on EOF also
// guarantees the stub dies with the test run rather than leaking a listener.
process.stdin.on('end', () => {
  process.stdout.write(`${JSON.stringify({ requests })}\n`, () => process.exit(0))
})
process.stdin.resume()
