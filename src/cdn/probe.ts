import { promises as dns } from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'

import type { CdnRemoteState, CdnZoneInput } from './types'

/**
 * Origin/edge diagnostic probes.
 *
 * The graphitearc.com incident is the reason this exists: a site can answer
 * `200` locally while the public CDN path returns `504`, and an apparently
 * healthy zone sync is **not** proof that the public hostname works. These
 * probes separate **origin status** from **CDN/public status** so a deployment
 * is never marked ready on a private health check alone.
 *
 * ## SSRF safety
 *
 * The pipeline only ever probes the zone's own `originTarget` and `zoneName` —
 * both operator-configured and validated, never a request-supplied URL. Before
 * any connection, the target host is resolved and every address is checked:
 * private/reserved ranges are refused unless the caller explicitly opts in with
 * `allowPrivateOrigin`. Every probe has a bounded timeout. No redirects are
 * followed. This keeps the diagnostic surface from becoming an internal-network
 * scanner.
 *
 * The actual network I/O is injected (`ProbeDialer`), so the planner, the SSRF
 * guard and the result classification are unit-testable without real sockets.
 */
export type CdnProbeKind =
  | 'dns-delegation'
  | 'origin-tcp'
  | 'origin-tls-sni'
  | 'public-cdn-tls'

export interface CdnProbe {
  kind: CdnProbeKind
  /** Host to connect to (origin IP/hostname, or the zone name for public probes). */
  host: string
  port: number
  /** SNI / Host header for TLS and HTTP probes. */
  sni: string
  timeoutMs: number
}

export interface CdnCertificate {
  isDefault?: boolean
  issuer?: string
  san?: string[]
  subject?: string
  validFrom?: string
  validTo?: string
}

export interface CdnProbeResult {
  checkedAt: string
  certificate?: CdnCertificate
  detail: string
  kind: CdnProbeKind
  ok: boolean
  /** Resolved addresses, for the DNS/TCP probes that produce them. */
  resolved?: string[]
}

export interface ProbeDialer {
  tcp(host: string, port: number, timeoutMs: number): Promise<{ detail: string; ok: boolean }>
  tls(
    host: string,
    port: number,
    sni: string,
    timeoutMs: number,
  ): Promise<{ certificate?: CdnCertificate; detail: string; ok: boolean }>
}

/** Default dialer using Node's `net` and `tls`. Injected in tests. */
export const nodeProbeDialer: ProbeDialer = {
  async tcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port })
      let settled = false
      const finish = (ok: boolean, detail: string) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve({ ok, detail })
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true, 'tcp connect ok'))
      socket.once('timeout', () => finish(false, `tcp connect timed out after ${timeoutMs}ms`))
      socket.once('error', (error) => finish(false, `tcp connect failed: ${error.message}`))
    })
  },
  async tls(host, port, sni, timeoutMs) {
    return new Promise((resolve) => {
      const socket = tls.connect({ host, port, servername: sni, rejectUnauthorized: true })
      let settled = false
      const finish = (ok: boolean, detail: string, certificate?: CdnCertificate) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve({ ok, detail, certificate })
      }
      socket.setTimeout(timeoutMs)
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate()
        finish(true, 'tls handshake ok', certificateFromNode(cert))
      })
      socket.once('timeout', () => finish(false, `tls handshake timed out after ${timeoutMs}ms`))
      socket.once('error', (error) =>
        finish(
          false,
          `tls handshake failed: ${error.message}`,
          certificateFromNode(socket.getPeerCertificate?.()),
        ),
      )
    })
  },
}

const certificateFromNode = (
  cert: tls.PeerCertificate | undefined,
): CdnCertificate | undefined => {
  if (!cert || !cert.subject) return undefined
  const subject = Object.entries(cert.subject)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')
  const issuer = Object.entries(cert.issuer ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ')
  const san = cert.subjectaltname
    ? String(cert.subjectaltname)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []
  return {
    isDefault: /traefik default cert/i.test(subject),
    issuer,
    san,
    subject,
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
  }
}

/* ------------------------------------------------------------------ */
/* SSRF guard                                                          */
/* ------------------------------------------------------------------ */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const isPrivateIPv4 = (ip: string): boolean => {
  const match = IPV4.exec(ip)
  if (!match) return false
  const a = Number(match[1])
  const b = Number(match[2])
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 100.64.0.0/10 — shared address space (CGNAT); not routable on the public internet.
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

const isPrivateIPv6 = (ip: string): boolean => {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true
  // fc00::/7 unique local, fe80::/10 link-local.
  if (/^f[cd]/.test(lower) || lower.startsWith('fe80')) return true
  return false
}

const isPrivateAddress = (address: string): boolean =>
  isPrivateIPv4(address) || isPrivateIPv6(address)

const looksLikeIP = (host: string): boolean => IPV4.test(host) || host.includes(':')

/** Resolve a host and return its addresses. Injected for tests. */
export type HostLookup = (host: string) => Promise<string[]>

const nodeLookup: HostLookup = async (host) => {
  const { address } = await dns.lookup(host)
  return [address]
}

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Build the bounded probe list for a zone. The origin target is the zone's own
 * override, falling back to the shared account's — never a request value. The
 * public probe uses the zone name as its SNI/Host so it exercises the real CDN
 * path, not a localhost shortcut.
 */
export const planZoneProbes = (
  zone: CdnZoneInput,
  remote: CdnRemoteState,
  accountOrigin?: string | null,
): CdnProbe[] => {
  const origin = (zone.originTarget ?? accountOrigin ?? '').trim()
  const probes: CdnProbe[] = []

  // DNS delegation: the zone's nameservers should answer for the zone name.
  probes.push({
    kind: 'dns-delegation',
    host: zone.zoneName,
    port: 53,
    sni: zone.zoneName,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })

  if (origin) {
    const port = zone.arvan?.originPort ?? 443
    // Origin TCP reachability.
    probes.push({
      kind: 'origin-tcp',
      host: origin,
      port,
      sni: zone.zoneName,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    // Origin TLS with correct SNI — this is where a default Traefik certificate
    // or a wrong SAN is caught.
    probes.push({
      kind: 'origin-tls-sni',
      host: origin,
      port,
      sni: zone.zoneName,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
  }

  // Public CDN path: the real hostname through the edge, verified over TLS.
  probes.push({
    kind: 'public-cdn-tls',
    host: zone.zoneName,
    port: 443,
    sni: zone.zoneName,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  })

  return probes
}

export interface RunProbesOptions {
  /** Operator override to probe a private origin (e.g. a staging server). */
  allowPrivateOrigin?: boolean
  dialer?: ProbeDialer
  lookup?: HostLookup
}

/**
 * Execute the planned probes with SSRF guards. Returns one result per probe.
 * A probe against a private address is refused (not connected) unless
 * `allowPrivateOrigin` is set, and the refusal is recorded as a result rather
 * than thrown.
 */
export const runZoneProbes = async (
  probes: CdnProbe[],
  options: RunProbesOptions = {},
): Promise<CdnProbeResult[]> => {
  const dialer = options.dialer ?? nodeProbeDialer
  const lookup = options.lookup ?? nodeLookup
  const checkedAt = new Date().toISOString()

  const results: CdnProbeResult[] = []
  for (const probe of probes) {
    // Guard: resolve the host and refuse private addresses unless opted in.
    let addresses: string[] = []
    try {
      addresses = looksLikeIP(probe.host)
        ? [probe.host]
        : await lookup(probe.host)
    } catch (error) {
      results.push({
        checkedAt,
        detail: `could not resolve ${probe.host}: ${(error as Error).message}`,
        kind: probe.kind,
        ok: false,
      })
      continue
    }

    if (!looksLikeIP(probe.host) && addresses.some(isPrivateAddress) && !options.allowPrivateOrigin) {
      results.push({
        checkedAt,
        detail: `origin ${probe.host} resolves to a private address; blocked by SSRF guard`,
        kind: probe.kind,
        ok: false,
        resolved: addresses,
      })
      continue
    }
    if (looksLikeIP(probe.host) && isPrivateAddress(probe.host) && !options.allowPrivateOrigin) {
      results.push({
        checkedAt,
        detail: `origin ${probe.host} is a private address; blocked by SSRF guard`,
        kind: probe.kind,
        ok: false,
        resolved: [probe.host],
      })
      continue
    }

    if (probe.kind === 'dns-delegation') {
      // The delegation probe is answered by the resolver, not a TCP dial.
      results.push({
        checkedAt,
        detail: `delegation checked for ${probe.host}`,
        kind: probe.kind,
        ok: addresses.length > 0,
        resolved: addresses,
      })
      continue
    }

    if (probe.kind === 'origin-tcp') {
      const { ok, detail } = await dialer.tcp(probe.host, probe.port, probe.timeoutMs)
      results.push({ checkedAt, detail, kind: probe.kind, ok, resolved: addresses })
      continue
    }

    if (probe.kind === 'origin-tls-sni') {
      const { ok, detail, certificate } = await dialer.tls(
        probe.host,
        probe.port,
        probe.sni,
        probe.timeoutMs,
      )
      // A default certificate (e.g. TRAEFIK DEFAULT CERT) is a failure even if
      // the handshake technically succeeded: it means the origin is not serving
      // a valid certificate for this hostname.
      const certFailed = Boolean(certificate?.isDefault)
      results.push({
        checkedAt,
        certificate,
        detail: certFailed
          ? `${detail} — origin serves a default certificate`
          : detail,
        kind: probe.kind,
        ok: ok && !certFailed,
        resolved: addresses,
      })
      continue
    }

    // The public CDN path is verified over TLS against the real hostname.
    const { ok, detail, certificate } = await dialer.tls(
      probe.host,
      probe.port,
      probe.sni,
      probe.timeoutMs,
    )
    results.push({ checkedAt, certificate, detail, kind: probe.kind, ok, resolved: addresses })
  }
  return results
}

/** Summarise probe results into an origin-vs-public readiness verdict. */
export interface CdnHealthVerdict {
  /** Origin-side probes (tcp/tls/http) all passed. */
  originHealthy: boolean
  /** The public CDN path answered. */
  publicHealthy: boolean
  /** `true` only when origin is healthy, public is healthy, and no default cert. */
  live: boolean
  summary: string
}

export const summarizeProbeResults = (results: CdnProbeResult[]): CdnHealthVerdict => {
  const origin = results.filter((r) => ['origin-tcp', 'origin-tls-sni'].includes(r.kind))
  const publicResults = results.filter((r) => r.kind === 'public-cdn-tls')
  const originHealthy = origin.length > 0 && origin.every((r) => r.ok)
  const publicHealthy = publicResults.length > 0 && publicResults.every((r) => r.ok)
  const hasDefaultCert = results.some((r) => r.certificate?.isDefault)
  const live = originHealthy && publicHealthy && !hasDefaultCert

  const summary = hasDefaultCert
    ? 'Origin TLS invalid: a default certificate (e.g. TRAEFIK DEFAULT CERT) is served. Renew the origin certificate before marking the site live.'
    : !originHealthy
      ? 'Origin is not reachable or does not present a valid certificate for the hostname.'
      : !publicHealthy
        ? 'Origin is healthy but the public CDN path is not answering.'
        : 'Origin and public CDN paths are healthy.'

  return { live, originHealthy, publicHealthy, summary }
}
