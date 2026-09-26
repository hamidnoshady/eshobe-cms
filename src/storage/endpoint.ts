import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isPrivateAddress } from '@/payments/gateways/net'

/**
 * Endpoint safety for operator-entered S3 URLs.
 *
 * Reuses the payment gateway SSRF floor (`isPrivateAddress`) rather than copying it.
 * Storage endpoints are not host-allowlisted — MinIO and private networks are valid
 * when explicitly permitted by env.
 */

export class UnsafeStorageEndpoint extends Error {
  readonly reason: string

  constructor(reason: string, message?: string) {
    super(message ?? `نشانی endpoint مجاز نیست (${reason})`)
    this.name = 'UnsafeStorageEndpoint'
    this.reason = reason
  }
}

const insecureHttpAllowed = (): boolean =>
  process.env.STORAGE_ALLOW_INSECURE_HTTP === 'true' ||
  process.env.NODE_ENV !== 'production'

const privateEndpointAllowed = (): boolean => process.env.STORAGE_ALLOW_PRIVATE_ENDPOINT === 'true'

/** Strip trailing slashes and reject paths/query/userinfo on the endpoint URL. */
export const normalizeStorageEndpoint = (raw: string): string => {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new UnsafeStorageEndpoint('unparsable', 'نشانی endpoint معتبر نیست.')
  }

  if (url.username || url.password) {
    throw new UnsafeStorageEndpoint('embedded-credentials', 'اعتبارنامه را در endpoint قرار ندهید.')
  }

  if (url.pathname && url.pathname !== '/') {
    throw new UnsafeStorageEndpoint('path-not-allowed', 'endpoint نباید مسیر داشته باشد.')
  }

  if (url.search || url.hash) {
    throw new UnsafeStorageEndpoint('query-not-allowed', 'endpoint نباید query یا hash داشته باشد.')
  }

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecureHttpAllowed())) {
    throw new UnsafeStorageEndpoint('not-https', 'در production فقط https:// مجاز است.')
  }

  return `${url.protocol}//${url.host}`
}

export type EndpointCheckOptions = {
  resolve?: (hostname: string) => Promise<string[]>
}

/** Full check including DNS → private IP rejection (async — use in hooks, not field validate). */
export const assertSafeStorageEndpoint = async (
  raw: string,
  options: EndpointCheckOptions = {},
): Promise<string> => {
  const normalized = normalizeStorageEndpoint(raw)
  const { hostname } = new URL(normalized)

  if (isIP(hostname)) {
    if (!privateEndpointAllowed() && isPrivateAddress(hostname)) {
      throw new UnsafeStorageEndpoint('private-ip')
    }
    return normalized
  }

  if (process.env.STORAGE_SKIP_DNS === 'true') return normalized

  const resolve =
    options.resolve ??
    (async (host: string) =>
      (await lookup(host, { all: true, verbatim: true })).map(({ address }) => address))

  let addresses: string[]
  try {
    addresses = await resolve(hostname)
  } catch (error) {
    throw new UnsafeStorageEndpoint(
      `unresolvable:${(error as NodeJS.ErrnoException).code ?? 'NXDOMAIN'}`,
      'نام میزبان endpoint قابل resolve نیست.',
    )
  }

  if (!addresses.length) throw new UnsafeStorageEndpoint('unresolvable')

  if (!privateEndpointAllowed() && addresses.some(isPrivateAddress)) {
    throw new UnsafeStorageEndpoint('resolves-to-private-address')
  }

  return normalized
}
