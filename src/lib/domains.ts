import type { Site } from '@/payload-types'

/**
 * A DNS host, not a URL. The platform intentionally stores the hostname only so
 * the value can be compared to the HTTP Host header and passed safely to Caddy's
 * TLS authorisation endpoint.
 *
 * `.localhost` is allowed for the multi-domain development setup. Production
 * hosts still require a normal DNS suffix.
 */
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|localhost)$/

export const domainValidationMessage =
  'دامنه باید یک میزبان معتبر باشد: بدون پروتکل، پورت، مسیر یا فاصله.'

/**
 * Canonical form used everywhere a host becomes a database key. A trailing dot
 * is valid DNS syntax but is not a distinct website, so it never reaches the
 * database as a second spelling of the same hostname.
 */
export const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.$/, '')

export const isValidDomain = (value: string): boolean =>
  HOSTNAME_PATTERN.test(normalizeDomain(value))

/** `Host` has a port during local development; persisted domains never do. */
export const hostFromHeader = (value: null | string | undefined): string =>
  normalizeDomain((value ?? '').split(':')[0] ?? '')

/** Shape deliberately structural: it is also usable before generated Payload types update. */
export type DomainAlias = {
  hostname?: null | string
  id?: null | string
  verified?: boolean | null
}

type DomainSite = Pick<Site, 'domain'> & { domains?: DomainAlias[] | null }

/**
 * Finds the exact alias row for one hostname. The row must be verified before it
 * can resolve a tenant — a pending hostname is only a DNS/TLS setup request,
 * never a way to attach an arbitrary Host request to a site.
 */
export const domainAliasForHost = (site: DomainSite, host: string): DomainAlias | null => {
  const normalized = hostFromHeader(host)

  return (
    site.domains?.find(
      (alias) =>
        typeof alias?.hostname === 'string' && normalizeDomain(alias.hostname) === normalized,
    ) ?? null
  )
}

export type SiteHostMatch = {
  /** The canonical hostname is the only URL the application emits. */
  canonical: boolean
  hostname: string
  verified: boolean
}

/**
 * Whether a site owns a hostname and, for aliases, whether it is allowed to
 * serve it. The primary host preserves the existing dev behaviour: it can
 * render before the operator has marked it TLS-ready. Caddy's production TLS
 * endpoint still requires `domainVerified` for that primary host.
 */
export const siteHostMatch = (
  site: DomainSite & { domainVerified?: boolean | null },
  host: string,
): SiteHostMatch | null => {
  const normalized = hostFromHeader(host)

  if (!normalized) return null

  if (normalizeDomain(site.domain) === normalized) {
    return { canonical: true, hostname: normalized, verified: Boolean(site.domainVerified) }
  }

  const alias = domainAliasForHost(site, normalized)
  if (!alias?.verified) return null

  return { canonical: false, hostname: normalized, verified: true }
}

/** All persisted hosts for friendly validation and collision diagnostics. */
export const siteHostnames = (site: DomainSite): string[] => [
  normalizeDomain(site.domain),
  ...(site.domains ?? [])
    .map(({ hostname }) => (typeof hostname === 'string' ? normalizeDomain(hostname) : ''))
    .filter(Boolean),
]
