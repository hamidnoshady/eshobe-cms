/**
 * The scheme a deployed theme's public hostname is reached over.
 *
 * `https` always, except on a developer machine whose Coolify proxy has no certificate
 * authority to reach (`*.sslip.io` / `*.localhost` cannot be issued one): there
 * `DEPLOY_PUBLIC_SCHEME=http` makes the Coolify domains, the health check, the theme's
 * own `ESHOBE_PUBLIC_ORIGIN` and the «باز کردن پیش‌نمایش» link agree on plain http.
 * Read per call, not at import — a constant captured at load is silently frozen.
 */
export const deployScheme = (): 'http' | 'https' =>
  process.env.DEPLOY_PUBLIC_SCHEME?.trim().toLowerCase() === 'http' ? 'http' : 'https'

/** `scheme://host` for a hostname the deploy pipeline talks to or hands to Coolify. */
export const deployOrigin = (hostname: string): string => `${deployScheme()}://${hostname}`

/**
 * Public URL for a theme deployment's application hostname.
 *
 * Preview and health checks always target the Coolify hostname (`previewDomain`),
 * never the customer's production domain.
 */
export const previewHttpsUrl = (hostname: null | string | undefined): null | string => {
  const host = String(hostname ?? '').trim()
  if (!host) return null
  return deployOrigin(host)
}
