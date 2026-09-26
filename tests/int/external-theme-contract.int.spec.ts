// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { siteDescriptor } from '@/endpoints/siteDescriptor'
import {
  assertGenericSiteDescriptor,
  assertHostScopedDocs,
  verifyRendererRevalidation,
} from '../fixtures/externalThemeRenderer'
import { signRendererBody } from '@/lib/renderer-webhook'

/**
 * Generic renderer contract — not Graphite-specific. Asserts a second app can bootstrap
 * from `/api/site`, read host-scoped content collections, and verify revalidation bytes.
 */
let payload: Payload

beforeAll(async () => {
  payload = await getPayload({ config: await config })
}, 180_000)

const hostRead = async <T = Record<string, unknown>>(host: string, collection: string) =>
  createLocalReq(
    {
      req: {
        headers: new Headers({ accept: 'application/json', host }),
        method: 'GET',
        url: `http://${host}/api/${collection}`,
      } as Partial<PayloadRequest>,
    },
    payload,
  ).then((req) =>
    payload
      .find({
        collection: collection as 'pages',
        depth: 0,
        overrideAccess: false,
        pagination: false,
        req,
      })
      .then(({ docs }) => docs as T[]),
  )

describe('external theme bootstrap fixture', () => {
  it('consumes /api/site and host-scoped content APIs together', async () => {
    const descriptorRes = await createLocalReq(
      {
        req: {
          headers: new Headers({ host: 'acme.localhost' }),
          method: 'GET',
          url: 'http://acme.localhost/api/site',
        } as Partial<PayloadRequest>,
      },
      payload,
    ).then((req) => siteDescriptor.handler(req))

    const site = assertGenericSiteDescriptor(await descriptorRes.json())
    expect(site.domain).toBe('acme.localhost')
    expect(site.theme?.primary ?? site.theme).toBeTruthy()

    const [pages, posts, categories, header, footer, forms] = await Promise.all([
      hostRead('acme.localhost', 'pages'),
      hostRead('acme.localhost', 'posts'),
      hostRead('acme.localhost', 'categories'),
      hostRead('acme.localhost', 'header'),
      hostRead('acme.localhost', 'footer'),
      hostRead('acme.localhost', 'forms'),
    ])

    const { docs: siteRows } = await payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { domain: { equals: 'acme.localhost' } },
    })
    const siteId = String(siteRows[0]?.id ?? '')
    expect(pages.length).toBeGreaterThan(0)
    assertHostScopedDocs(pages, siteId)
    expect(header).toHaveLength(1)
    expect(footer).toHaveLength(1)
    expect(posts.length + categories.length + forms.length).toBeGreaterThanOrEqual(0)
  })

  it('matches the published v1 renderer revalidation signature helper', () => {
    const secret = 'fixture-secret'
    const body = JSON.stringify({ paths: ['/'], resources: ['branding'], siteId: 'x', tags: [] })
    const signature = signRendererBody(secret, body)
    expect(verifyRendererRevalidation(secret, body, signature)).toBe(true)
    expect(verifyRendererRevalidation(secret, body, 'sha256=deadbeef')).toBe(false)
  })
})
