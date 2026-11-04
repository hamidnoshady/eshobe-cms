/**
 * EdDSA/Ed25519 verification of Torob's request JWT.
 *
 * The audience is the site's *stored canonical hostname*. `Host` establishes which
 * tenant row to read (the platform's socket rule); it never becomes the audience.
 * Forwarded host headers are not read at all. Node's crypto verifies Ed25519 directly,
 * so the public feed does not pull a JWT library into the browser or trust `alg=none`.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto'

export const TOROB_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt6Mu4T0pBORY11W+QeM35UsmLO3vsf+6yKpFDEImFk0=
-----END PUBLIC KEY-----`
export const TOROB_TOKEN_HEADER = 'x-torob-token'
export const TOROB_TOKEN_VERSION_HEADER = 'x-torob-token-version'
export const TOROB_TOKEN_VERSION = '1'

export type TorobAuthFailure =
  | 'audience_mismatch'
  | 'expired'
  | 'invalid_token'
  | 'missing_token'
  | 'missing_token_version'
  | 'not_yet_valid'
  | 'unsupported_token_version'
  | 'wrong_algorithm'

export type TorobAuthResult =
  | { ok: false; reason: TorobAuthFailure }
  | { ok: true; audience: string; expiresAt: number }

export const torobPublicKeyPem = (env: Record<string, string | undefined> = process.env): string => {
  const configured = env.TOROB_API_PUBLIC_KEY?.trim()
  if (!configured) return TOROB_PUBLIC_KEY_PEM
  return configured.includes('BEGIN PUBLIC KEY')
    ? configured
    : `-----BEGIN PUBLIC KEY-----\n${configured}\n-----END PUBLIC KEY-----`
}

export const hostForTorobAudience = (value: string): string =>
  value.trim().toLowerCase().replace(/\.$/, '')

const audienceMatches = (aud: unknown, expectedHost: string): boolean => {
  const expected = hostForTorobAudience(expectedHost)
  const candidates = Array.isArray(aud) ? aud : [aud]
  return candidates.some((candidate) => {
    if (typeof candidate !== 'string') return false
    const normalized = hostForTorobAudience(candidate)
    // The token guide allows an audience port; the stored domain never carries one.
    return normalized === expected || normalized.replace(/:\d+$/, '') === expected
  })
}

const decodePart = (part: string): Record<string, unknown> | null => {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) return null
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const value: unknown = JSON.parse(json)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export const torobAuthHeaders = (headers: Headers) => ({
  token: headers.get(TOROB_TOKEN_HEADER),
  tokenVersion: headers.get(TOROB_TOKEN_VERSION_HEADER),
})

export const verifyTorobToken = async (input: {
  expectedHost: string
  now?: Date
  publicKeyPem?: string
  token: null | string
  tokenVersion: null | string
}): Promise<TorobAuthResult> => {
  const token = input.token?.trim()
  if (!token) return { ok: false, reason: 'missing_token' }
  const version = input.tokenVersion?.trim()
  if (!version) return { ok: false, reason: 'missing_token_version' }
  if (version !== TOROB_TOKEN_VERSION) return { ok: false, reason: 'unsupported_token_version' }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'invalid_token' }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]
  const header = decodePart(headerPart)
  if (!header) return { ok: false, reason: 'invalid_token' }
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'wrong_algorithm' }
  // No critical extensions or unencoded payloads: this feed only needs the plain JWT shape.
  if ('crit' in header || header.b64 === false) return { ok: false, reason: 'invalid_token' }

  let key: KeyObject
  try {
    key = createPublicKey(input.publicKeyPem ?? torobPublicKeyPem())
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'invalid_token' }
  } catch {
    return { ok: false, reason: 'invalid_token' }
  }

  try {
    const signature = Buffer.from(signaturePart, 'base64url')
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'utf8')
    if (!verify(null, signed, key, signature)) return { ok: false, reason: 'invalid_token' }
  } catch {
    return { ok: false, reason: 'invalid_token' }
  }

  const claims = decodePart(payloadPart)
  if (!claims) return { ok: false, reason: 'invalid_token' }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  const exp = claims.exp
  const nbf = claims.nbf
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'invalid_token' }
  if (typeof nbf !== 'number' || !Number.isFinite(nbf)) return { ok: false, reason: 'invalid_token' }
  if (exp <= nowSeconds) return { ok: false, reason: 'expired' }
  if (nbf > nowSeconds) return { ok: false, reason: 'not_yet_valid' }
  if (!audienceMatches(claims.aud, input.expectedHost)) {
    return { ok: false, reason: 'audience_mismatch' }
  }

  return { ok: true, audience: hostForTorobAudience(input.expectedHost), expiresAt: exp }
}
