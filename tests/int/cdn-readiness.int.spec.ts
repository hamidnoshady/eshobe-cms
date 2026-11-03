// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { CdnHealthVerdict } from '@/cdn/probe'
import { evaluateDeploymentReadiness } from '@/cdn/readiness'
import type { CdnSyncResult } from '@/cdn/types'

const healthySync = (): CdnSyncResult => ({
  actions: [{ name: 'sync:dns-records', state: 'applied' }],
  externalIds: {},
})

const healthyVerdict = (): CdnHealthVerdict => ({
  originHealthy: true,
  publicHealthy: true,
  live: true,
  summary: 'all healthy',
})

describe('deployment readiness gate', () => {
  it('is ready when sync applied the desired state and both paths are healthy', () => {
    const readiness = evaluateDeploymentReadiness(healthySync(), healthyVerdict())
    expect(readiness.ready).toBe(true)
    expect(readiness.originStatus).toBe('healthy')
    expect(readiness.publicStatus).toBe('healthy')
    expect(readiness.reasons).toEqual([])
    expect(readiness.syncOk).toBe(true)
  })

  it('blocks when sync could not apply the desired state', () => {
    const sync: CdnSyncResult = {
      actions: [
        { name: 'sync:dns-records', state: 'applied' },
        { name: 'sync:ssl', state: 'blocked', detail: 'provider rejected' },
      ],
      externalIds: {},
    }
    const readiness = evaluateDeploymentReadiness(sync, healthyVerdict())
    expect(readiness.ready).toBe(false)
    expect(readiness.syncOk).toBe(false)
    expect(readiness.reasons[0]).toContain('did not apply the desired state')
  })

  it('blocks when the origin is unreachable or has an invalid certificate', () => {
    const verdict: CdnHealthVerdict = {
      originHealthy: false,
      publicHealthy: true,
      live: false,
      summary: 'origin TLS invalid',
    }
    const readiness = evaluateDeploymentReadiness(healthySync(), verdict)
    expect(readiness.ready).toBe(false)
    expect(readiness.originStatus).toBe('unhealthy')
    expect(readiness.reasons).toContain('Origin is unreachable or serving an invalid certificate')
  })

  it('blocks when the public CDN path is unhealthy', () => {
    const verdict: CdnHealthVerdict = {
      originHealthy: true,
      publicHealthy: false,
      live: false,
      summary: 'public path down',
    }
    const readiness = evaluateDeploymentReadiness(healthySync(), verdict)
    expect(readiness.ready).toBe(false)
    expect(readiness.publicStatus).toBe('unhealthy')
    expect(readiness.reasons).toContain('Public CDN path is not healthy')
  })

  it('blocks a default origin certificate even when both paths handshake', () => {
    // Both paths are technically healthy (handshakes succeed), but a default
    // TRAEFIK DEFAULT CERT means `live` is false — the site must not go live.
    const verdict: CdnHealthVerdict = {
      originHealthy: true,
      publicHealthy: true,
      live: false,
      summary: 'Origin TLS invalid: a default certificate is served.',
    }
    const readiness = evaluateDeploymentReadiness(healthySync(), verdict)
    expect(readiness.ready).toBe(false)
    expect(readiness.reasons).toContain('A default certificate is served on the origin')
  })
})
