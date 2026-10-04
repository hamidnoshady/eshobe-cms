import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { PUBLIC_READ_CACHE_CONTROL, PUBLIC_READ_MAX_LIMIT } from '@/lib/public-read-limits'

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
})
