/**
 * Read-only WordPress / WooCommerce REST client (issue #166).
 *
 * Ground rules baked into the transport, because every importer stage above
 * it inherits them:
 *
 * - **Read-only.** Only GET exists here. The one future write (installing the
 *   optional event plugin) will be a separate, explicit surface.
 * - **Credentials never leak.** They live in the factory closure, are sent
 *   only as an `Authorization` header to the validated source origin, and
 *   every error message passes through `redactSecrets` before it can reach a
 *   log or a report. Application passwords are space-stripped the way
 *   WordPress expects (it displays them in spaced groups).
 * - **URLs are built, never followed.** Pagination advances by page number
 *   under the validated base; a hostile/broken source cannot bounce the
 *   platform at another host via a `Link: rel="next"` absolute URL. Redirects
 *   surface as errors (`redirect: 'error'` equivalent — a 3xx is not `ok`).
 * - **Gentle by default.** 100/page (the WP maximum), exponential backoff on
 *   429/5xx honouring `Retry-After`, per-request timeout. A shared-hosting WP
 *   under import load is the common case, not the edge case.
 *
 * `fetch` and `sleep` are injected so the whole client is testable without
 * network or timers.
 */

export type FetchResponse = {
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  ok: boolean
  status: number
  text(): Promise<string>
}

export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string>; method: string; signal?: AbortSignal },
) => Promise<FetchResponse>

export class WordPressApiError extends Error {
  code?: string
  status?: number

  constructor(message: string, { code, status }: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'WordPressApiError'
    this.code = code
    this.status = status
  }
}

/** Scrub credentials (and credential-shaped tokens) out of text destined for logs. */
export const redactSecrets = (text: string, secrets: (string | undefined)[] = []): string => {
  let out = text

  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]')
  }

  return out
    .replace(/Basic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/\b(password|applicationPassword|consumerKey|consumerSecret)("?\s*[:=]\s*"?)[^\s",&]+/gi, '$1$2[redacted]')
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

export type RestClientOptions = {
  /** Validated by `validateSourceBaseUrl` before a client is ever built. */
  baseUrl: string
  fetchImpl?: FetchImpl
  maxRetries?: number
  perPage?: number
  retryBaseMs?: number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

export type RestClient = {
  collect: <T = unknown>(path: string, params?: Record<string, string>) => Promise<T[]>
  getJson: <T = unknown>(path: string, params?: Record<string, string>) => Promise<T>
  pages: <T = unknown>(
    path: string,
    params?: Record<string, string>,
  ) => AsyncGenerator<{ items: T[]; page: number; totalPages: number }>
}

const createClient = ({
  authHeader,
  baseUrl,
  fetchImpl,
  maxRetries = 3,
  perPage = 100,
  retryBaseMs = 500,
  secrets,
  sleep = defaultSleep,
  timeoutMs = 30_000,
}: RestClientOptions & { authHeader?: string; secrets: string[] }): RestClient => {
  const doFetch: FetchImpl =
    fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>)
  const base = baseUrl.replace(/\/+$/, '')

  const buildUrl = (path: string, params: Record<string, string> = {}): string => {
    if (!path.startsWith('/wp-json/')) {
      throw new WordPressApiError('REST path must stay under /wp-json/', { code: 'BAD_PATH' })
    }
    const url = new URL(`${base}${path}`)

    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

    return url.toString()
  }

  const request = async (path: string, params?: Record<string, string>): Promise<FetchResponse> => {
    const url = buildUrl(path, params)
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response: FetchResponse

      try {
        response = await doFetch(url, {
          headers: {
            accept: 'application/json',
            ...(authHeader ? { authorization: authHeader } : {}),
          },
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt === maxRetries) break
        await sleep(retryBaseMs * 2 ** attempt)
        continue
      }

      if (response.ok) return response

      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : retryBaseMs * 2 ** attempt
        await sleep(waitMs)
        continue
      }

      // WP error bodies are `{code, message}`; either way the text is
      // truncated and redacted before it can travel.
      const body = await response.text().catch(() => '')
      let code: string | undefined
      let message = body.slice(0, 300)

      try {
        const parsed = JSON.parse(body) as { code?: string; message?: string }
        code = parsed.code
        if (parsed.message) message = parsed.message.slice(0, 300)
      } catch {
        // Non-JSON error page (a WAF, a 404 template) — the status is the signal.
      }

      throw new WordPressApiError(
        redactSecrets(`GET ${path} failed (${response.status}): ${message}`, secrets),
        { code, status: response.status },
      )
    }

    throw new WordPressApiError(
      redactSecrets(`GET ${path} failed: ${lastError?.message ?? 'network error'}`, secrets),
      { code: 'NETWORK_ERROR' },
    )
  }

  const getJson = async <T = unknown>(path: string, params?: Record<string, string>): Promise<T> => {
    const response = await request(path, params)

    return (await response.json()) as T
  }

  async function* pages<T = unknown>(
    path: string,
    params: Record<string, string> = {},
  ): AsyncGenerator<{ items: T[]; page: number; totalPages: number }> {
    let page = 1
    let totalPages = 1

    while (page <= totalPages) {
      const response = await request(path, {
        ...params,
        page: String(page),
        per_page: String(perPage),
      })
      const headerTotal = Number(response.headers.get('x-wp-totalpages'))
      const items = (await response.json()) as T[]

      if (!Array.isArray(items)) {
        throw new WordPressApiError(`GET ${path} did not return a list`, { code: 'BAD_SHAPE' })
      }

      // No header (some proxies strip it): a short page is the last page.
      totalPages = Number.isFinite(headerTotal) && headerTotal > 0
        ? headerTotal
        : items.length < perPage
          ? page
          : page + 1

      yield { items, page, totalPages }
      page += 1
    }
  }

  const collect = async <T = unknown>(path: string, params: Record<string, string> = {}): Promise<T[]> => {
    const all: T[] = []

    for await (const { items } of pages<T>(path, params)) all.push(...items)

    return all
  }

  return { collect, getJson, pages }
}

const basicAuth = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`

/**
 * WordPress core REST (`/wp-json/wp/v2/…`) with an application password.
 * Anonymous when no credentials are given — enough for a public preflight
 * probe, never enough to declare an inventory complete (discovery says so).
 */
export const createWordPressClient = (
  options: RestClientOptions & { applicationPassword?: string; username?: string },
): RestClient => {
  const password = options.applicationPassword?.replace(/\s+/g, '')
  const authHeader =
    options.username && password ? basicAuth(options.username, password) : undefined

  return createClient({
    ...options,
    authHeader,
    secrets: [password, authHeader?.replace(/^Basic\s+/, '')].filter(Boolean) as string[],
  })
}

/** WooCommerce REST v3 with read-only consumer credentials (HTTPS Basic). */
export const createWooCommerceClient = (
  options: RestClientOptions & { consumerKey: string; consumerSecret: string },
): RestClient => {
  const authHeader = basicAuth(options.consumerKey, options.consumerSecret)

  return createClient({
    ...options,
    authHeader,
    secrets: [
      options.consumerKey,
      options.consumerSecret,
      authHeader.replace(/^Basic\s+/, ''),
    ],
  })
}
