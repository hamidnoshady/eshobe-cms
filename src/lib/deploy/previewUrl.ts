/**
 * Public HTTPS URL for a theme deployment's application hostname.
 *
 * Preview and health checks always target the Coolify hostname (`previewDomain`),
 * never the customer's production domain.
 */
export const previewHttpsUrl = (hostname: null | string | undefined): null | string => {
  const host = String(hostname ?? '').trim()
  if (!host) return null
  return `https://${host}`
}
