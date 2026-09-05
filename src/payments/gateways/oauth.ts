import type { PayloadRequest } from 'payload'

import { gatewayFetch } from './net'

import type { GatewayResponse } from './net'

/**
 * The OAuth2 password-grant handshake Digipay and Snapp!Pay both use, and the token
 * cache that makes it usable.
 *
 * Both providers issue a bearer token from a `client_id:client_secret` Basic header plus
 * a form body of `username`/`password`/`grant_type=password`, and both answer with
 * `access_token` + `expires_in` (Digipay's docs put `expires_in` at 3599s; Snapp!Pay's
 * integration packages cache it the same way). So it is one function, not two.
 *
 * ## Why the cache is not optional
 *
 * Without it, every buyer's checkout costs two round trips to the PSP — one to log in,
 * one to open the transaction — against a merchant credential that most providers rate
 * limit and some lock after repeated logins. With it, one login serves an hour of
 * checkouts.
 *
 * ## Why it is in-process
 *
 * The same reasoning `src/lib/rate-limit.ts` writes down: this deployment is one web
 * container on one VPS, so a process-local `Map` is the right size and a shared store
 * would be a new part to keep alive. **Behind more than one replica the cache is
 * per-replica**, which costs one extra login per replica per hour and nothing else — no
 * correctness depends on it, because a 401 invalidates and retries.
 *
 * ## What is never cached
 *
 * The client secret and the password. The cache key is a hash-free composition of
 * site/row/mode that is safe to log; the values inside it are the access token only,
 * which is short-lived by construction and already in the PSP's own logs.
 */

type CachedToken = { expiresAt: number; token: string }

const tokens = new Map<string, CachedToken>()

/** Refresh this long before the PSP's own expiry: a token that dies mid-request is a failed checkout. */
const EXPIRY_SKEW_MS = 60_000

/** A provider that omits `expires_in` still gets a bounded lifetime. */
const FALLBACK_TTL_MS = 5 * 60_000

export type BearerTokenRequest = {
  allowedHosts: string[]
  clientId: string
  clientSecret: string
  /** Identifies the tenant's row, not the credential: `${siteId}:${rowId}:${mode}`. */
  key: string
  password: string
  req: PayloadRequest
  /** Snapp!Pay asks for `online-merchant`; Digipay does not send one. */
  scope?: string
  username: string
  url: string
}

export const invalidateBearerToken = (key: string): void => {
  tokens.delete(key)
}

/**
 * A live access token, from the cache or from the provider.
 *
 * Throws on failure rather than returning `null`: the caller is an adapter that cannot do
 * anything without it, and the exception it throws is the one `resolve.ts` turns into
 * "the gateway did not answer" for the buyer and a real reason in the log.
 */
export const bearerToken = async ({
  allowedHosts,
  clientId,
  clientSecret,
  key,
  password,
  req,
  scope,
  url,
  username,
}: BearerTokenRequest): Promise<string> => {
  const cached = tokens.get(key)

  if (cached && cached.expiresAt > Date.now()) return cached.token

  const response = await gatewayFetch(
    url,
    allowedHosts,
    {
      // `Authorization: Basic base64(client_id:client_secret)` — both providers' docs,
      // and the reason `clientId` is a secret field even though it looks like an
      // identifier: it is half of a credential pair.
      form: {
        grant_type: 'password',
        password,
        ...(scope ? { scope } : {}),
        username,
      },
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
      },
      method: 'POST',
    },
    req,
  )

  const accessToken =
    typeof response.json?.access_token === 'string' ? response.json.access_token : null

  if (!response.ok || !accessToken) {
    // The status is logged; the body is not, because a failed OAuth response from some
    // providers echoes the submitted username back.
    req.payload.logger.warn({
      msg: `payment gateway oauth failed (${response.status})`,
      oauth: { status: response.status, url },
    })

    throw new Error(`oauth token request failed with ${response.status}`)
  }

  const expiresIn = Number(response.json?.expires_in)
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : FALLBACK_TTL_MS

  tokens.set(key, { expiresAt: Date.now() + ttl - EXPIRY_SKEW_MS, token: accessToken })

  return accessToken
}

/**
 * Call an authenticated endpoint, re-authenticating once on a 401.
 *
 * The retry is what makes the cache safe to have at all: a token revoked early, a
 * provider that restarts, or a clock that disagrees all produce a 401 on a call the cache
 * said was fine. Without the retry those read as "the gateway is down" to a buyer whose
 * money is fine.
 */
export const authenticatedCall = async (
  args: BearerTokenRequest,
  call: (token: string) => Promise<GatewayResponse>,
): Promise<GatewayResponse> => {
  const first = await call(await bearerToken(args))

  if (first.status !== 401) return first

  invalidateBearerToken(args.key)

  return call(await bearerToken(args))
}

/** Test seam: a cached token would otherwise outlive the fixture that created it. */
export const resetBearerTokens = (): void => {
  tokens.clear()
}
