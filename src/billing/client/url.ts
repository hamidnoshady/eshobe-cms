/**
 * The central Billing origin is configuration, not a request field. Production
 * refuses anything but HTTPS and refuses link-local and cloud metadata hosts.
 */

const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.internal'])

const isIpLiteral = (host: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')

const isPrivateOrLocal = (host: string): boolean => {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (!isIpLiteral(host)) return false
  if (host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) {
    return true
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true
  if (host.startsWith('169.254.') || host === '::1' || host.startsWith('fe80:') || host.startsWith('fd')) return true
  return false
}

export const centralBillingUrl = (raw = process.env.CENTRAL_BILLING_URL): null | URL => {
  const value = raw?.trim()
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('CENTRAL_BILLING_URL is not a URL.')
  }
  if (url.username || url.password) throw new Error('CENTRAL_BILLING_URL must not carry credentials.')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CENTRAL_BILLING_URL must be http or https.')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (BLOCKED_HOSTS.has(host)) throw new Error('CENTRAL_BILLING_URL host is blocked.')
  const production = process.env.NODE_ENV === 'production'
  if (production && url.protocol !== 'https:') throw new Error('CENTRAL_BILLING_URL must be https in production.')
  if (production && isPrivateOrLocal(host)) throw new Error('CENTRAL_BILLING_URL must be a public https origin in production.')
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

export const usageIngestUrl = (origin: URL): string => `${origin.origin}${origin.pathname}/api/internal/billing/usage/v1/batch`

export const entitlementPullUrl = (origin: URL, siteId: string): string => {
  const url = new URL(`${origin.origin}${origin.pathname}/api/internal/billing/entitlements/v1`)
  url.searchParams.set('siteId', siteId)
  return url.toString()
}
