import { describe, expect, it } from 'vitest'

import {
  boundedPublicDepth,
  boundedPublicLimit,
  capPublicCollectionReads,
  isAdminSessionForReadLimits,
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_MAX_DEPTH,
  PUBLIC_READ_MAX_LIMIT,
} from '@/lib/public-read-limits'

describe('public REST and GraphQL collection read limits', () => {
  it('clamps zero/unbounded and oversized limits, including pagination=false requests', () => {
    expect(boundedPublicLimit(undefined)).toBe(PUBLIC_READ_MAX_LIMIT)
    expect(boundedPublicLimit(0)).toBe(PUBLIC_READ_MAX_LIMIT)
    expect(boundedPublicLimit(-1)).toBe(PUBLIC_READ_MAX_LIMIT)
    expect(boundedPublicLimit(1)).toBe(1)
    expect(boundedPublicLimit(100_000)).toBe(PUBLIC_READ_MAX_LIMIT)
  })

  it('caps depth without turning a collection default of zero into a deeper query', () => {
    expect(boundedPublicDepth(20)).toBe(PUBLIC_READ_MAX_DEPTH)
    expect(boundedPublicDepth(0)).toBe(0)
  })

  it('recognizes browser/admin sessions but not Payload or MCP API-key identities', () => {
    expect(isAdminSessionForReadLimits({ _strategy: 'local-jwt' })).toBe(true)
    expect(isAdminSessionForReadLimits({})).toBe(true)
    expect(isAdminSessionForReadLimits(null)).toBe(false)
    expect(isAdminSessionForReadLimits({ _strategy: 'api-key' })).toBe(false)
    expect(isAdminSessionForReadLimits({ _strategy: 'mcp-api-key' })).toBe(false)
  })

  it('applies the bound before the adapter for REST reads even when pagination is disabled', () => {
    const args = { limit: undefined as number | undefined, pagination: false, depth: 9 }
    const result = capPublicCollectionReads({
      args: args as never,
      context: {} as never,
      collection: { defaultDepth: 1 } as never,
      operation: 'read',
      req: { payloadAPI: 'REST', user: null } as never,
    })

    expect(result).toBe(args)
    expect(args.limit).toBe(PUBLIC_READ_MAX_LIMIT)
    expect(args.depth).toBe(PUBLIC_READ_MAX_DEPTH)
  })

  it('keeps admin reads unlimited and leaves Local API rendering/seed calls unchanged', () => {
    const adminArgs = { limit: 5000, depth: 8 }
    capPublicCollectionReads({
      args: adminArgs as never,
      context: {} as never,
      collection: { defaultDepth: 1 } as never,
      operation: 'read',
      req: { payloadAPI: 'REST', user: { _strategy: 'local-jwt' } } as never,
    })
    expect(adminArgs).toEqual({ limit: 5000, depth: 8 })

    const localArgs = { limit: 5000, depth: 8 }
    capPublicCollectionReads({
      args: localArgs as never,
      context: {} as never,
      collection: { defaultDepth: 1 } as never,
      operation: 'read',
      req: { payloadAPI: 'local', user: null } as never,
    })
    expect(localArgs).toEqual({ limit: 5000, depth: 8 })
  })

  it('caps requests authenticated by a user-backed API key', () => {
    const args = { limit: 5000, depth: 5 }
    capPublicCollectionReads({
      args: args as never,
      context: {} as never,
      collection: { defaultDepth: 1 } as never,
      operation: 'read',
      req: { payloadAPI: 'GraphQL', user: { _strategy: 'api-key' } } as never,
    })

    expect(args).toEqual({ limit: PUBLIC_READ_MAX_LIMIT, depth: PUBLIC_READ_MAX_DEPTH })
  })

  it('caches only anonymous REST GETs of the public content allowlist by host', () => {
    const req = {
      headers: new Headers(),
      method: 'GET',
      payloadAPI: 'REST',
      responseHeaders: new Headers(),
      user: null,
    }
    capPublicCollectionReads({
      args: { depth: 1, limit: 10 } as never,
      context: {} as never,
      collection: { slug: 'pages' } as never,
      operation: 'read',
      req: req as never,
    })

    expect(req.responseHeaders.get('cache-control')).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(req.responseHeaders.get('vary')).toContain('Host')
  })

  it('marks credentialed and GraphQL reads private and non-cacheable', () => {
    for (const req of [
      {
        headers: new Headers({ authorization: 'Bearer site-key' }),
        method: 'GET',
        payloadAPI: 'REST',
        responseHeaders: new Headers(),
        user: null,
      },
      {
        headers: new Headers(),
        method: 'POST',
        payloadAPI: 'GraphQL',
        responseHeaders: new Headers(),
        user: null,
      },
    ]) {
      capPublicCollectionReads({
        args: { depth: 1, limit: 10 } as never,
        context: {} as never,
        collection: { slug: 'pages' } as never,
        operation: 'read',
        req: req as never,
      })
      expect(req.responseHeaders.get('cache-control')).toBe('private, no-store')
    }
  })
})
