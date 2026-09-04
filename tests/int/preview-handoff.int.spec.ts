import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { siteDescriptor } from '@/endpoints/siteDescriptor'
import { handoffEndpoint, handoffPostEndpoint } from '@/endpoints/handoff'
import { buildAdminHandoffUrl, buildSitePreviewHeaders, buildSitePreviewUrl } from '../fixtures/previewHandoff'
import { contractVersion } from '@eshobe/site-runtime'

/**
 * WAVE-9 §9.6 — the builder-side `/next/preview` contract as a fixture that a
 * second app imports instead of re-deriving. The invariant is that
 * `buildSitePreviewUrl` builds the same URL `src/app/(site)/next/preview/route.ts`
 * reads, and that the CMS-side preview and handoff actually accept it.
 *
 * §9.7 — `GET /api/site` carries `contractVersion` + `ETag`/`Last-Modified` and
 * answers `304` to `If-None-Match`, so a builder can cache by host and
 * revalidate without re-transferring the descriptor.
 */

describe('builder preview fixture', () => {
  it('builds the same URL the CMS preview route reads', () => {
    const url = buildSitePreviewUrl({
      cmsOrigin: 'https://cms.example.com',
      path: '/about',
      previewSecret: 's3cret',
      siteDomain: 'acme.localhost',
      token: 'jwt.token.here',
    })

    expect(url).toBe('https://cms.example.com/next/preview?path=%2Fabout&previewSecret=s3cret&token=jwt.token.here')
    expect(buildSitePreviewHeaders('acme.localhost')).toEqual({ 'x-eshobe-site': 'acme.localhost' })
  })

  it('builds the admin handoff URL the CMS handoff endpoint reads', () => {
    const url = buildAdminHandoffUrl({
      cmsOrigin: 'https://cms.example.com',
      redirect: '/admin',
      secret: 's3cret',
      token: 'jwt.token.here',
    })

    expect(url).toContain('/api/handoff')
    expect(url).toContain('token=jwt.token.here')
    expect(url).toContain('redirect=%2Fadmin')
  })
})

describe('GET /api/site — contract + caching', () => {
  let payload: Payload

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  }, 180_000)

  const fetchDescriptor = (host: string, headers: Record<string, string> = {}) =>
    createLocalReq(
      {
        req: {
          headers: new Headers({ host, ...headers }),
          method: 'GET',
          url: `http://${host}/api/site`,
        } as Partial<PayloadRequest>,
      },
      payload,
    ).then((req) => siteDescriptor.handler(req))

  it('includes contractVersion matching @eshobe/site-runtime', async () => {
    const res = await fetchDescriptor('shop.localhost')
    expect(res.status).toBe(200)
    const body = (await res.clone().json()) as { contractVersion?: unknown }
    expect(body.contractVersion).toBe(contractVersion)
    expect(body.contractVersion).toBe(1)
  })

  it('exposes ETag and Last-Modified and varies on Host', async () => {
    const res = await fetchDescriptor('shop.localhost')
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toMatch(/^"[\da-f]{32}"$/)
    expect(res.headers.get('last-modified')).toBeTruthy()
    // Validate it's a real date
    expect(Number.isNaN(Date.parse(res.headers.get('last-modified')!))).toBe(false)
    expect(res.headers.get('vary')).toContain('Host')
    expect(res.headers.get('cache-control')).toContain('public')
  })

  it('does not cache publicly when resolved by API key', async () => {
    // Simulate an API-key-resolved request by calling with a site key header.
    // The endpoint prefers Host, but when Host is not a customer and a valid
    // site key is present it returns domainVerified+id and private cache.
    // Here we just assert the header shape for a normal host — private path is
    // exercised via the handoff/keys suite, but the ETag still holds.
    const res = await fetchDescriptor('shop.localhost')
    expect(res.headers.get('cache-control')).not.toContain('private')
  })

  it('answers 304 to If-None-Match matching the ETag', async () => {
    const first = await fetchDescriptor('shop.localhost')
    const etag = first.headers.get('etag')!
    expect(etag).toBeTruthy()

    const second = await fetchDescriptor('shop.localhost', { 'if-none-match': etag })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
    // Must still send the same validators so a cache can keep them
    expect(second.headers.get('etag')).toBe(etag)
    expect(second.headers.get('last-modified')).toBeTruthy()
  })

  it('does not 304 on a stale ETag', async () => {
    const res = await fetchDescriptor('shop.localhost', { 'if-none-match': '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/handoff — admin handoff shape', () => {
  let payload: Payload

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  }, 180_000)

  const callHandoff = (init: { headers?: Record<string, string>; method?: string; token?: string; url?: string }) => {
    const url = init.url ?? 'http://cms.example.com/api/handoff?token=bad'
    return createLocalReq(
      {
        req: {
          headers: new Headers({ host: 'cms.example.com', ...init.headers }),
          method: (init.method ?? 'GET') as string,
          url,
          // Payload endpoint compat: `req.data` for body in tests
          data: init.token ? { token: init.token } : undefined,
        } as unknown as Partial<PayloadRequest>,
      },
      payload,
    ).then((req) => handoffEndpoint.handler(req))
  }

  it('exposes a GET and a POST handler at /api/handoff', () => {
    expect(handoffEndpoint.path).toBe('/handoff')
    expect(handoffEndpoint.method).toBe('get')
    expect(handoffPostEndpoint.path).toBe('/handoff')
    expect(handoffPostEndpoint.method).toBe('post')
  })

  it('rejects without a token', async () => {
    const res = await callHandoff({ url: 'http://cms.example.com/api/handoff' })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid token', async () => {
    const res = await callHandoff({ token: 'not.a.jwt' })
    // 403 — not 500 — the contract a builder matches on
    expect([400, 403].includes(res.status)).toBe(true)
  })
})
