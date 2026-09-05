import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { PayloadRequest } from 'payload'

/**
 * The only HTTP client a gateway adapter is allowed to use.
 *
 * Three things live here that an adapter must not re-implement, because each of them is
 * a decision about *who a tenant's configuration can make this server talk to*, and a
 * per-adapter copy is a per-adapter chance to get it wrong:
 *
 * 1. **A host allowlist.** `baseUrl` is a per-row setting — it has to be, because Snapp!Pay
 *    and Torob Pay hand each merchant their own address — which means a value in the
 *    database decides where a request from this server goes. Every URL is checked against
 *    the gateway's own published domains before it is fetched.
 * 2. **An SSRF floor under that.** The allowlist stops a *typo*; it cannot stop a
 *    platform admin from allowlisting something that resolves inward, and a hostname is
 *    not an address. So the resolved IPs are checked against the private, loopback,
 *    link-local, CGNAT and cloud-metadata ranges, and `http:` is refused outright unless
 *    a deployment says otherwise.
 * 3. **Secret redaction in logs.** A `client_secret` in an `Authorization` header and a
 *    `password` in a JSON body are the two easiest credentials in this codebase to leak
 *    into a log aggregator. Nothing an adapter passes to `logger` goes through here, so
 *    this module logs the request itself — with the sensitive headers replaced — and
 *    never the body.
 *
 * ## What this is not
 *
 * Not a full pinning proxy. DNS is resolved once to decide, and `fetch` resolves it again
 * to connect, so a hostile resolver with a short TTL can still answer differently the
 * second time. Closing that needs a custom undici `Dispatcher` that connects to the
 * address already vetted; the allowlist above is what makes that a hardening exercise
 * rather than the only defence. `docs/payment-gateways.md` says so plainly.
 */

/** A PSP response is a small JSON object. Anything bigger is a mistake or an attack. */
const MAX_RESPONSE_BYTES = 256 * 1024

const timeoutMs = (): number => Number(process.env.PAYMENT_GATEWAY_TIMEOUT_MS ?? 10_000)

/**
 * Addresses a request from this server must never be sent to.
 *
 * Written as ranges rather than a library because the list is short, the shapes are
 * stable, and a dependency that decides what "private" means is a dependency that can
 * change its mind about the platform's network boundary.
 */
const PRIVATE_V4 = [
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./, // link-local, and 169.254.169.254 is every cloud's metadata service
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT (RFC6598)
  /^0\./, // "this" network
  /^22[4-9]\./, // multicast and reserved
  /^2[3-5]\d\./, // reserved
]

const isPrivateV4 = (address: string): boolean => PRIVATE_V4.some((pattern) => pattern.test(address))

/**
 * IPv6's equivalent. The two that matter are `::1` and the IPv4-mapped form, because a
 * resolver that answers `::ffff:127.0.0.1` is answering "localhost" and the v4 check
 * above never sees it.
 */
const isPrivateV6 = (address: string): boolean => {
  const normalized = address.toLowerCase()

  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80')) return true // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // unique-local
  if (normalized.startsWith('::ffff:')) return isPrivateV4(normalized.slice(7))

  return false
}

/** Exported for the tests: a pure predicate over an address, with no DNS involved. */
export const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address)

  if (version === 4) return isPrivateV4(address)
  if (version === 6) return isPrivateV6(address)

  // Not an IP at all. A hostname is not "safe" — it is unchecked — and this function is
  // only ever called with something `dns.lookup` returned, so a non-IP here is a bug.
  return true
}

/**
 * Host suffixes the platform adds to every gateway's own allowlist.
 *
 * Read per call, for the same reason as the timeout: a frozen env var is a silently
 * frozen policy, and this one is exactly what a deployment changes when a PSP moves
 * domain and the merchant cannot transact until it is fixed.
 */
export const extraAllowedHosts = (): string[] =>
  (process.env.PAYMENT_GATEWAY_EXTRA_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)

/**
 * Suffix match, not substring match: `evil-zarinpal.com` and `zarinpal.com.attacker.tld`
 * both *contain* `zarinpal.com`, and neither is ZarinPal.
 */
const hostAllowed = (hostname: string, allowedHosts: string[]): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, '')

  return [...allowedHosts, ...extraAllowedHosts()].some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  )
}

export class UnsafeGatewayUrl extends Error {
  constructor(reason: string) {
    // The reason is logged, never shown to a buyer: "resolves to 169.254.169.254" is
    // useful to whoever is debugging a merchant's configuration and to nobody else.
    super(`درگاه: نشانی مجاز نیست (${reason})`)
    this.name = 'UnsafeGatewayUrl'
    this.reason = reason
  }

  reason: string
}

export type UrlCheckOptions = {
  allowedHosts: string[]
  /** Test seam: what the hostname resolves to. Defaults to `dns.lookup`. */
  resolve?: (hostname: string) => Promise<string[]>
}

/**
 * Parse and vet a URL before anything is fetched. Returns the parsed URL so the caller
 * does not parse it twice and cannot accidentally fetch the unvetted string.
 */
export const assertSafeGatewayUrl = async (raw: string, options: UrlCheckOptions): Promise<URL> => {
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeGatewayUrl('unparsable')
  }

  const insecureAllowed = process.env.PAYMENT_GATEWAY_ALLOW_INSECURE === 'true'

  // `http:` sends a merchant's `client_secret` in cleartext over the Iranian internet.
  // Allowed only where a deployment explicitly says so — a staging PSP behind a VPN, or
  // a local mock in a test — and never by default.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecureAllowed)) {
    throw new UnsafeGatewayUrl('not-https')
  }

  if (!url.hostname) throw new UnsafeGatewayUrl('no-host')

  if (!hostAllowed(url.hostname, options.allowedHosts)) {
    throw new UnsafeGatewayUrl('host-not-allowlisted')
  }

  // An IP literal is refused outright rather than range-checked: no PSP's API lives at a
  // bare address, and "the admin typed 169.254.169.254" has no legitimate version.
  if (isIP(url.hostname)) throw new UnsafeGatewayUrl('ip-literal')

  if (process.env.PAYMENT_GATEWAY_SKIP_DNS === 'true') return url

  const resolve =
    options.resolve ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address))

  let addresses: string[]

  try {
    addresses = await resolve(url.hostname)
  } catch (error) {
    // Unresolvable is refused, not waved through: an adapter that fetches anyway would
    // report a DNS failure as a gateway outage, which sends the merchant to their PSP.
    throw new UnsafeGatewayUrl(`unresolvable:${(error as NodeJS.ErrnoException).code ?? 'NXDOMAIN'}`)
  }

  if (!addresses.length) throw new UnsafeGatewayUrl('unresolvable')
  if (addresses.some(isPrivateAddress)) throw new UnsafeGatewayUrl('resolves-to-private-address')

  return url
}

/** A parsed, non-secret view of a request — what is safe to put in a log line. */
export type GatewayLog = { body?: string; headers: Record<string, string>; method: string; url: string }

const REDACTED = '[redacted]'

/** Header names whose value is a credential in every gateway this platform ships. */
const SECRET_HEADERS = ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']

export const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SECRET_HEADERS.includes(name.toLowerCase()) ? REDACTED : value,
    ]),
  )

export type GatewayResponse = {
  /** `null` when the body was not a JSON object. `text` still holds it. */
  json: null | Record<string, unknown>
  ok: boolean
  status: number
  text: string
}

export type GatewayRequest = {
  body?: Record<string, unknown> | string
  headers?: Record<string, string>
  method?: 'GET' | 'POST'
  query?: Record<string, null | number | string | undefined>
  /** Form-encoded rather than JSON — Digipay's and Snapp!Pay's OAuth endpoints want it. */
  form?: Record<string, string>
}

/**
 * Fetch a vetted URL, with a timeout, a size cap, no redirect following and one log line.
 *
 * `redirect: 'manual'` is the part that matters: following a redirect would let the
 * allowlist be satisfied by the first hop and the request land anywhere the PSP — or
 * whoever is answering for it — chooses. A 3xx is reported to the adapter as a status
 * code instead, and no adapter here treats one as success.
 */
export const gatewayFetch = async (
  rawUrl: string,
  allowedHosts: string[],
  request: GatewayRequest,
  req: PayloadRequest,
): Promise<GatewayResponse> => {
  const url = await assertSafeGatewayUrl(rawUrl, { allowedHosts })

  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value === null || value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }

  const method = request.method ?? 'POST'
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers }

  let body: string | undefined

  if (request.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(request.form).toString()
  } else if (request.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json'
    body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
  }

  // The URL, the method and the redacted headers. Never the body: for two of the four
  // gateways the body of the OAuth call *is* the password.
  req.payload.logger.info({
    gateway: { headers: redactHeaders(headers), method, url: url.toString() },
    msg: 'payment gateway request',
  })

  const response = await fetch(url, {
    body: method === 'GET' ? undefined : body,
    // `no-store` so a caching proxy in front of this container never replays a payment
    // request — the same reason `src/payments/http.ts` sets it.
    cache: 'no-store',
    headers,
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs()),
  })

  const text = await readCapped(response)

  if (!response.ok) {
    req.payload.logger.warn({
      gateway: { method, status: response.status, url: url.toString() },
      msg: 'payment gateway non-2xx',
    })
  }

  return { json: parseJsonObject(text), ok: response.ok, status: response.status, text }
}

/**
 * Read at most `MAX_RESPONSE_BYTES`, then stop.
 *
 * `response.text()` on an unbounded body is how a misconfigured or hostile endpoint
 * turns one checkout into an out-of-memory restart of the web container that serves every
 * tenant. A truncated body fails the JSON parse, which an adapter reports as "the gateway
 * answered badly" — the honest reading.
 */
const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader()

  if (!reader) return (await response.text()).slice(0, MAX_RESPONSE_BYTES)

  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    if (!value) continue

    total += value.byteLength
    chunks.push(value)

    if (total >= MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      break
    }
  }

  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString('utf8')
}

/** A JSON *object*, or `null`. Arrays and scalars are not what any of these APIs answer with. */
export const parseJsonObject = (text: string): null | Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Join a base URL and a path without the two-slash or no-slash bug.
 *
 * Snapp!Pay publishes its base with a trailing slash and its endpoints without a leading
 * one; Torob Pay's paths arrive from a merchant's panel in whatever shape they were copied
 * in. Both are per-row settings, so both get normalised here rather than in each adapter.
 */
export const joinUrl = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`

/**
 * Pull a value out of a nested PSP response without a dozen `?.` chains at every call
 * site. `path` is dot-separated; the first key that holds a non-empty value wins, which
 * is what lets an adapter accept `ref_id` and `refId` from the same provider.
 */
export const pick = (source: unknown, ...paths: string[]): null | number | string => {
  for (const path of paths) {
    let current: unknown = source

    for (const segment of path.split('.')) {
      if (!current || typeof current !== 'object') {
        current = undefined
        break
      }

      current = (current as Record<string, unknown>)[segment]
    }

    if (typeof current === 'string' && current.trim()) return current
    if (typeof current === 'number' && Number.isFinite(current)) return current
  }

  return null
}

/** The first absolute `https` URL among several candidate response fields, or `null`. */
export const pickUrl = (source: unknown, ...paths: string[]): null | string => {
  for (const path of paths) {
    const value = pick(source, path)

    if (typeof value !== 'string') continue

    try {
      const url = new URL(value)

      // The redirect target is a *browser* destination, not a server-to-server call, so
      // it is not held to the API allowlist — but it is held to `https`, because sending
      // a buyer to a plaintext page with an order id in the query is a leak.
      if (url.protocol === 'https:') return url.toString()
    } catch {
      // Not a URL; try the next candidate.
    }
  }

  return null
}
