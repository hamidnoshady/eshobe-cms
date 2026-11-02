// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  planZoneProbes,
  runZoneProbes,
  summarizeProbeResults,
  type CdnCertificate,
  type ProbeDialer,
} from '@/cdn/probe'
import type { CdnZoneInput } from '@/cdn/types'

/**
 * The graphitearc.com regression fixture: ArvanCloud edge → Srv1 Traefik
 * (45.94.213.43) → Srv2 theme app (94.184.41.141). The origin the CDN proxies to
 * is Srv1's Traefik. When Srv1 serves its **default** certificate (subject
 * `CN=TRAEFIK DEFAULT CERT`) instead of a real one for the hostname, the site
 * must be diagnosed as origin-TLS-invalid — not falsely marked healthy because
 * the app on Srv2 answers 200 locally.
 */
const graphiteZone = (): CdnZoneInput => ({
  active: true,
  arvan: {},
  credentials: { apiToken: 'enc:v1:x' },
  dnsRecords: [],
  id: 'zone-graphite',
  originTarget: '45.94.213.43',
  provider: 'arvancloud',
  ssl: { mode: 'strict' },
  zoneName: 'graphitearc.com',
})

const remote = {
  dnsRecords: [],
  nameservers: ['ns1.arvancloud.ir', 'ns2.arvancloud.ir'],
  providerZoneId: 'arvan-zone',
  readAt: '2026-11-01T00:00:00.000Z',
  settings: {},
  status: 'active',
  zoneName: 'graphitearc.com',
}

const defaultCert = (): CdnCertificate => ({
  isDefault: true,
  issuer: 'CN=TRAEFIK DEFAULT CERT',
  san: [],
  subject: 'CN=TRAEFIK DEFAULT CERT',
  validFrom: '2026-01-01T00:00:00Z',
  validTo: '2027-01-01T00:00:00Z',
})

const validCert = (sni: string): CdnCertificate => ({
  isDefault: false,
  issuer: 'CN=R3',
  san: [sni],
  subject: 'CN=graphitearc.com',
  validFrom: '2026-01-01T00:00:00Z',
  validTo: '2027-01-01T00:00:00Z',
})

/** A dialer that models Srv1 serving a default Traefik cert on the origin TLS
 * probe, while the public CDN edge presents a valid cert. */
const graphiteDialer: ProbeDialer = {
  async tcp(host, port) {
    return { ok: host === '45.94.213.43', detail: `tcp ${host}:${port} ${host === '45.94.213.43' ? 'ok' : 'refused'}` }
  },
  async tls(host, _port, sni) {
    if (host === 'graphitearc.com') return { ok: true, detail: 'public edge tls ok', certificate: validCert(sni) }
    // Origin (Srv1 Traefik) hands back its default cert.
    return { ok: true, detail: 'origin tls handshake ok', certificate: defaultCert() }
  },
}

describe('graphitearc.com origin/edge probe regression', () => {
  it('surfaces a default Traefik certificate as origin-TLS-invalid, not healthy', async () => {
    const probes = planZoneProbes(graphiteZone(), remote)
    const results = await runZoneProbes(probes, { dialer: graphiteDialer })
    const verdict = summarizeProbeResults(results)

    // The origin TLS probe must fail even though the handshake succeeded.
    const originTls = results.find((r) => r.kind === 'origin-tls-sni')
    expect(originTls?.ok).toBe(false)
    expect(originTls?.certificate?.isDefault).toBe(true)

    expect(verdict.originHealthy).toBe(false)
    expect(verdict.live).toBe(false)
    expect(verdict.summary).toMatch(/default certificate|Origin TLS invalid/i)
  })

  it('reports live only when origin and public paths are healthy with a real cert', async () => {
    const healthyDialer: ProbeDialer = {
      async tcp() {
        return { ok: true, detail: 'ok' }
      },
      async tls(_host, _port, sni) {
        return { ok: true, detail: 'ok', certificate: validCert(sni) }
      },
    }
    const probes = planZoneProbes(graphiteZone(), remote)
    const verdict = summarizeProbeResults(await runZoneProbes(probes, { dialer: healthyDialer }))
    expect(verdict.originHealthy).toBe(true)
    expect(verdict.publicHealthy).toBe(true)
    expect(verdict.live).toBe(true)
  })
})

describe('SSRF guard on diagnostic probes', () => {
  const dialer: ProbeDialer = {
    async tcp() {
      return { ok: true, detail: 'should not be reached' }
    },
    async tls() {
      return { ok: true, detail: 'should not be reached' }
    },
  }

  it('blocks a private origin without an explicit opt-in', async () => {
    const zone = { ...graphiteZone(), originTarget: '192.168.1.10' }
    const probes = planZoneProbes(zone, remote)
    const results = await runZoneProbes(probes, { dialer })
    const originTls = results.find((r) => r.kind === 'origin-tls-sni')
    expect(originTls?.ok).toBe(false)
    expect(originTls?.detail).toMatch(/private address; blocked/i)
  })

  it('allows a private origin when the operator opts in', async () => {
    const zone = { ...graphiteZone(), originTarget: '192.168.1.10' }
    const probes = planZoneProbes(zone, remote)
    const results = await runZoneProbes(probes, { allowPrivateOrigin: true, dialer })
    const originTls = results.find((r) => r.kind === 'origin-tls-sni')
    expect(originTls?.ok).toBe(true)
  })
})
