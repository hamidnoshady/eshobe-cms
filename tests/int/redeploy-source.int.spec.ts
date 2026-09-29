// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { redeploySource } from '@/deploy/siteDeploymentSummary'

const production = { domainMode: 'direct', id: 'prod', lane: 'production', status: 'live' }
const preview = { domainMode: 'preview', id: 'prev', lane: 'preview', status: 'live' }
const oldPreview = { domainMode: 'preview', id: 'old', lane: 'preview', status: 'stopped' }
const site = { activeDeployment: 'prod' }

describe('redeploySource', () => {
  it('without a lane, starts from what serves the customer domain', () => {
    expect(redeploySource(site, [preview, production])?.id).toBe('prod')
  })

  it('with lane preview, starts from the preview — never rebuilds production', () => {
    // The console's «استقرار مجدد پیش‌نمایش» used to POST without a lane and rebuild the
    // active (production) deployment with its current artifact, unconfirmed.
    expect(redeploySource(site, [production, preview], 'preview')?.id).toBe('prev')
    expect(redeploySource(site, [oldPreview, production], 'preview')?.id).toBe('old')
  })

  it('with lane production, starts from production even when a preview is newer', () => {
    expect(redeploySource({}, [preview, production], 'production')?.id).toBe('prod')
  })

  it('falls back to the unscoped order when the lane has no row yet', () => {
    expect(redeploySource(site, [production], 'preview')?.id).toBe('prod')
  })

  it('reads legacy rows by domainMode when lane is absent', () => {
    const legacy = { domainMode: 'preview', id: 'legacy', status: 'live' }
    expect(redeploySource(site, [production, legacy], 'preview')?.id).toBe('legacy')
  })
})
