import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import {
  capPublicCollectionReads,
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_MAX_LIMIT,
} from '@/lib/public-read-limits'

describe('public read bounds through the Payload operation pipeline', () => {
  let payload: Payload

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  }, 180_000)

  const find = async (headers: Record<string, string>, options: { limit?: number; pagination?: boolean; depth?: number }) => {
    const host = headers.host ?? 'acme.localhost'
    const req = await createLocalReq(
      {
        req: {
          headers: new Headers({ accept: 'application/json', ...headers }),
          method: 'GET',
          payloadAPI: 'REST',
          url: `http://${host}/api/pages`,
        } as Partial<PayloadRequest>,
      },
      payload,
    )

    const result = await payload.find({
      collection: 'pages',
      depth: options.depth,
      limit: options.limit,
      overrideAccess: false,
      pagination: options.pagination,
      req,
    })

    return { req, result }
  }

  it('bounds pagination=false and oversized REST requests before the database query', async () => {
    const { result } = await find({ host: 'acme.localhost' }, { depth: 20, limit: 50_000, pagination: false })

    expect(result.limit).toBe(PUBLIC_READ_MAX_LIMIT)
    expect(result.docs.length).toBeLessThanOrEqual(PUBLIC_READ_MAX_LIMIT)
  })

  it('adds short shared-cache headers only to anonymous public REST reads', async () => {
    const { req } = await find({ host: 'acme.localhost' }, { limit: 10, pagination: true })

    expect(req.responseHeaders?.get('cache-control')).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(req.responseHeaders?.get('vary')).toContain('Host')
  })

  it('does not place bearer-key content in a shared cache', async () => {
    const { req } = await find(
      { authorization: 'Bearer invalid-key', host: 'acme.localhost' },
      { limit: 10, pagination: true },
    )

    expect(req.responseHeaders?.get('cache-control')).toBe('private, no-store')
  })

  it('keeps nested version routes private even when the collection itself is public', async () => {
    const req = await createLocalReq(
      {
        req: {
          headers: new Headers({ accept: 'application/json', host: 'acme.localhost' }),
          method: 'GET',
          payloadAPI: 'REST',
          url: 'http://acme.localhost/api/pages/example-id/versions',
        } as Partial<PayloadRequest>,
      },
      payload,
    )

    capPublicCollectionReads({
      args: { limit: 10 },
      collection: { slug: 'pages' },
      operation: 'findVersions',
      req,
    } as never)

    expect(req.responseHeaders?.get('cache-control')).toBe('private, no-store')
  })

  it('does not replace the media-file router cache policy', async () => {
    const req = await createLocalReq(
      {
        req: {
          headers: new Headers({ accept: 'image/avif,image/webp', host: 'acme.localhost' }),
          method: 'GET',
          payloadAPI: 'REST',
          url: 'http://acme.localhost/api/media/file/example.webp',
        } as Partial<PayloadRequest>,
      },
      payload,
    )

    capPublicCollectionReads({
      args: { depth: 0 },
      collection: { slug: 'media' },
      operation: 'findByID',
      req,
    } as never)

    expect(req.responseHeaders?.get('cache-control') ?? null).toBeNull()
  })

  it('leaves endpoint response headers alone during internal collection reads', async () => {
    const req = await createLocalReq(
      {
        req: {
          headers: new Headers({ accept: 'application/json', host: 'acme.localhost' }),
          method: 'GET',
          payloadAPI: 'REST',
          url: 'http://acme.localhost/api/platform/saas/overview',
        } as Partial<PayloadRequest>,
      },
      payload,
    )

    await payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
    })

    expect(req.responseHeaders?.get('cache-control') ?? null).toBeNull()
  })
})
