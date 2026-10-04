import type { CollectionBeforeOperationHook, PayloadRequest, Plugin } from 'payload'

/** Maximum collection rows returned by one anonymous/API-key REST or GraphQL read. */
export const PUBLIC_READ_MAX_LIMIT = 100
/** Maximum populated relationship depth on unprivileged HTTP reads. */
export const PUBLIC_READ_MAX_DEPTH = 2

const MACHINE_AUTH_STRATEGIES = new Set(['api-key', 'mcp-api-key'])

/** Collections whose anonymous HTTP representations contain public site content only. */
export const PUBLIC_CACHEABLE_COLLECTIONS = new Set([
  'categories',
  'forms',
  'footer',
  'header',
  'media',
  'pages',
  'posts',
  'products',
  'redirects',
  'search',
  'store',
  'theme',
])

export const PUBLIC_READ_CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=300'

/**
 * Any authenticated user may use the CMS editing UI without the public cap. Payload's
 * user-backed API-key strategies are machine credentials, not browser admin sessions,
 * and deliberately remain capped.
 */
export const isAdminSessionForReadLimits = (user: null | { _strategy?: string } | undefined): boolean =>
  Boolean(user) && !MACHINE_AUTH_STRATEGIES.has(user?._strategy ?? '')

const setPublicReadCacheHeaders = (
  req: PayloadRequest,
  collectionSlug: string,
): void => {
  const responseHeaders = req.responseHeaders ?? new Headers()
  const method = req.method?.toUpperCase()
  const authorization = req.headers?.get?.('authorization')
  const cookie = req.headers?.get?.('cookie')
  const publicGET =
    req.payloadAPI === 'REST' &&
    (method === 'GET' || method === 'HEAD') &&
    PUBLIC_CACHEABLE_COLLECTIONS.has(collectionSlug) &&
    !req.user &&
    !authorization &&
    !cookie

  if (publicGET) {
    responseHeaders.set('cache-control', PUBLIC_READ_CACHE_CONTROL)
    const vary = responseHeaders
      .get('vary')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? []
    if (!vary.some((value) => value.toLowerCase() === 'host')) vary.push('Host')
    responseHeaders.set('vary', vary.join(', '))
  } else {
    // Session, bearer-key and GraphQL responses are never eligible for shared caches.
    responseHeaders.set('cache-control', 'private, no-store')
  }

  req.responseHeaders = responseHeaders
}

export const boundedPublicLimit = (requested: unknown, max = PUBLIC_READ_MAX_LIMIT): number => {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

export const boundedPublicDepth = (requested: unknown, max = PUBLIC_READ_MAX_DEPTH): number => {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return max
  return Math.max(0, Math.min(Math.floor(requested), max))
}

/**
 * Caps the untrusted REST/GraphQL request before Payload reaches its database adapter.
 * `pagination: false` is intentionally not a bypass: an explicit `limit` is still
 * passed to the adapter, where Payload otherwise interprets an absent limit as
 * unbounded. An added `limit` is harmless for `findByID` (whose operation ignores it)
 * and keeps this hook compatible with Payload's legacy `read` hook operation name.
 */
export const capPublicCollectionReads: CollectionBeforeOperationHook = ({ args, collection, operation, req }) => {
  if (req.payloadAPI !== 'REST' && req.payloadAPI !== 'GraphQL') return

  setPublicReadCacheHeaders(req, collection.slug)
  if (isAdminSessionForReadLimits(req.user as null | { _strategy?: string } | undefined)) return

  if (
    operation !== 'find' &&
    operation !== 'findByID' &&
    operation !== 'read' &&
    operation !== 'findDistinct' &&
    operation !== 'readDistinct' &&
    operation !== 'findVersions' &&
    operation !== 'findVersionByID'
  ) {
    return
  }

  // The payload operation argument union contains several read shapes. Only list
  // operations consume `limit`; adding it to findByID does not affect that operation.
  const boundedArgs = args as typeof args & { depth?: number; limit?: number }
  boundedArgs.limit = boundedPublicLimit(boundedArgs.limit)
  boundedArgs.depth = boundedPublicDepth(boundedArgs.depth ?? req.payload.config.defaultDepth ?? 0)

  return args
}

/** Runs after all feature plugins so plugin-added collections (notably MCP keys) are covered. */
export const publicReadLimits: Plugin = (config) => ({
  ...config,
  collections: config.collections?.map((collection) => ({
    ...collection,
    hooks: {
      ...collection.hooks,
      beforeOperation: [...(collection.hooks?.beforeOperation ?? []), capPublicCollectionReads],
    },
  })),
})
