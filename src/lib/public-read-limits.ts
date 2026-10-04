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

const requestPathname = (req: PayloadRequest): string => {
  if (typeof req.pathname === 'string') return req.pathname

  try {
    return new URL(req.url ?? '/', `http://${req.host ?? 'localhost'}`).pathname
  } catch {
    return ''
  }
}

const normalizePath = (value: string): string => `/${value.split('/').filter(Boolean).join('/')}`

/**
 * Hooks also run for Local API reads performed *inside* an endpoint and for
 * relationships populated by another collection read. They share the original HTTP
 * request and response headers, but they are not the resource the caller requested.
 * Only the matching REST collection route owns its cache policy; GraphQL owns one
 * private policy for the entire `/graphql` response.
 */
const setPublicReadCacheHeaders = (
  req: PayloadRequest,
  collectionSlug: string,
): void => {
  const apiPath = normalizePath(req.payload.config.routes.api ?? '/api')
  const pathname = requestPathname(req)
  const collectionPath = `${apiPath}/${collectionSlug}`
  const matchesCollectionRoute =
    req.payloadAPI === 'REST' &&
    (pathname === collectionPath || pathname.startsWith(`${collectionPath}/`))
  const collectionSuffix = matchesCollectionRoute
    ? pathname.slice(collectionPath.length).split('/').filter(Boolean)
    : []
  const mediaFileRoute = collectionSlug === 'media' && collectionSuffix[0] === 'file'
  const directCollectionRoute = matchesCollectionRoute && !mediaFileRoute
  // The root list and `/collection/:id` are public document routes. Nested routes
  // such as `/collection/:id/versions` can expose drafts/history and stay private.
  const directPublicCollectionResourceRoute = collectionSuffix.length <= 1
  const graphQLPath = `${apiPath}${normalizePath(req.payload.config.routes.graphQL ?? '/graphql')}`
  const directGraphQLRoute = req.payloadAPI === 'GraphQL' && pathname === graphQLPath

  // Internal reads must not overwrite headers chosen by their endpoint (e.g. the
  // platform's exact `Cache-Control: no-store`) or another router policy (media
  // file responses have their own cache rule in `next.config.ts`).
  if (!directCollectionRoute && !directGraphQLRoute) return

  const responseHeaders = req.responseHeaders ?? new Headers()
  const method = req.method?.toUpperCase()
  const authorization = req.headers?.get?.('authorization')
  const cookie = req.headers?.get?.('cookie')
  const publicGET =
    directCollectionRoute &&
    directPublicCollectionResourceRoute &&
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
    // Session, bearer-key, mutations and GraphQL responses are never shared-cacheable.
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
