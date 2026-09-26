// @vitest-environment node
//
// Payload matches custom endpoints in array order and the first match wins, so a
// bare `/platform/sites/:id` registered before a specific `/platform/sites/:id/quota`
// swallows it: `:id` binds to the site, the `/quota` tail is ignored, and the
// handler answers 200 with the wrong body — the failure mode that does not look
// like one (see the load-bearing comment in `payload.config.ts`).
//
// The ordering is spread across three endpoint files assembled into one array in
// the config; nothing but reviewer memory keeps a future reorder from re-opening
// the trap. This pins it against the *built* config — no database — so any reorder
// that shadows a specific site route fails in CI (task §20).
import { describe, expect, it } from 'vitest'

import configPromise from '@/payload.config'

type Ep = { method: string; path: string }

const siteEndpoints = async (): Promise<{ i: number; method: string; path: string }[]> => {
  const config = await configPromise
  return (config.endpoints as Ep[])
    .map((e, i) => ({ i, method: String(e.method).toLowerCase(), path: e.path }))
    .filter((e) => e.path === '/platform/sites/:id' || e.path.startsWith('/platform/sites/:id/'))
}

describe('platform site endpoint ordering', () => {
  it('registers every specific /platform/sites/:id/* route before the bare /platform/sites/:id', async () => {
    const eps = await siteEndpoints()
    const bare = eps.filter((e) => e.path === '/platform/sites/:id')
    const specific = eps.filter((e) => e.path.startsWith('/platform/sites/:id/'))

    // Sanity: both kinds exist, or the guard is vacuously green against nothing.
    expect(bare.length, 'a bare /platform/sites/:id endpoint should exist').toBeGreaterThan(0)
    expect(specific.length, 'the specific sub-routes should exist').toBeGreaterThan(5)

    for (const s of specific) {
      for (const b of bare) {
        if (b.method !== s.method) continue
        expect(
          s.i,
          `${s.method.toUpperCase()} ${s.path} is registered after the bare ` +
            `${b.method.toUpperCase()} /platform/sites/:id (index ${s.i} ≥ ${b.i}) — it will be shadowed`,
        ).toBeLessThan(b.i)
      }
    }
  })

  it('covers the known-risky sub-routes the config comments call out', async () => {
    const paths = new Set((await siteEndpoints()).map((e) => e.path))
    // The exact routes the config header names as swallow-risks. If one is renamed,
    // this list is the reminder to update the ordering reasoning with it.
    for (const tail of ['quota', 'usage', 'features', 'theme', 'entitlement', 'deployment', 'snapshot', 'billing']) {
      expect(
        [...paths].some((p) => p === `/platform/sites/:id/${tail}` || p.startsWith(`/platform/sites/:id/${tail}`)),
        `expected a /platform/sites/:id/${tail} route to exist and be guarded`,
      ).toBe(true)
    }
  })

  it('registers every deployment lifecycle literal, each ahead of the bare site route', async () => {
    const eps = await siteEndpoints()
    const bare = eps.filter((e) => e.path === '/platform/sites/:id')
    const expected: [string, string][] = [
      ['get', '/platform/sites/:id/deployment'],
      ['post', '/platform/sites/:id/deployment'],
      ['post', '/platform/sites/:id/deployment/redeploy'],
      ['post', '/platform/sites/:id/deployment/rollback'],
      ['post', '/platform/sites/:id/deployment/stop'],
      ['post', '/platform/sites/:id/deployment/revert'],
      ['post', '/platform/sites/:id/deployment/poll'],
      ['post', '/platform/sites/:id/deployment/verify'],
    ]

    for (const [method, path] of expected) {
      const found = eps.find((e) => e.method === method && e.path === path)
      expect(found, `${method.toUpperCase()} ${path} must be registered`).toBeTruthy()
      for (const b of bare) {
        expect(found!.i, `${method.toUpperCase()} ${path} must precede the bare site route`).toBeLessThan(b.i)
      }
    }
  })
})
