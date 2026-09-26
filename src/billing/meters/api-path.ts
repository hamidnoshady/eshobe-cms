/**
 * Which HTTP paths count as a customer API request.
 *
 * Counted: a request authenticated with a site API key, once, on a customer
 * API path.
 *
 * Not counted: platform and billing routes, health, jobs, media bytes (those
 * are origin transfer), login, and any call that has no URL — hooks and jobs
 * invoke `requestApiKey` without being a customer request.
 */

const EXCLUDED_PREFIXES = [
  '/api/platform',
  '/api/internal',
  '/api/payload-jobs',
  '/api/health',
  '/api/media',
  '/api/access',
  '/api/users/login',
  '/api/users/me',
  '/api/users/logout',
  '/api/users/refresh-token',
  '/api/users/forgot-password',
  '/api/users/reset-password',
]

export const pathnameOf = (url: string | undefined): null | string => {
  if (!url) return null
  try {
    return new URL(url, 'http://cms.local').pathname
  } catch {
    return url.startsWith('/') ? url.split('?')[0]! : null
  }
}

export const isBillableCustomerApiPath = (url: string | undefined): boolean => {
  const path = pathnameOf(url)
  if (!path?.startsWith('/api/')) return false
  return !EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}
