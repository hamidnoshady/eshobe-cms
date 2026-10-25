import { EMBED_MARKER_COOKIE } from '@/lib/embed'

/**
 * Two rules for `/admin` that the proxy applies per request: who may frame the panel,
 * and what to do when the POS modal's embed session has leaked into a top-level visit.
 * Pure — `src/proxy.ts` does the I/O, `tests/int/admin-frame.int.spec.ts` pins it.
 */

/** Payload's tenant-selector cookie — the embed sets its own copy (`platformEmbed.ts`). */
const TENANT_COOKIE = 'payload-tenant'

/** Set for a few seconds by the clean-up redirect, so a browser that refuses to drop a cookie cannot loop. */
export const EMBED_EXIT_COOKIE = 'eshobe-embed-exit'

const parseOrigins = (raw: string | undefined): string[] => {
  const out: string[] = []
  for (const candidate of (raw ?? '').split(',')) {
    const value = candidate.trim()
    if (!value) continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.origin)
    } catch {
      // A malformed entry widens nothing.
    }
  }
  return out
}

/**
 * `frame-ancestors` for `/admin/*`. Read per call from the *runtime* environment, unioned
 * with whatever the image was built with (`ADMIN_EMBED_ORIGINS_BUILD`, inlined by
 * `next.config.ts`). It used to be a `next.config` header, which Next bakes into the
 * routes manifest at build time: an image built without the repository variable answered
 * `frame-ancestors 'self'` forever, and the POS modal showed the browser's broken-frame
 * icon with no way to fix it short of a rebuild.
 */
export const adminFrameAncestors = (
  // Spelled out as literals: Next inlines `process.env.ADMIN_EMBED_ORIGINS_BUILD` only
  // where it appears verbatim.
  runtime: string | undefined = process.env.ADMIN_EMBED_ORIGINS,
  build: string | undefined = process.env.ADMIN_EMBED_ORIGINS_BUILD,
): string => {
  const origins = new Set([...parseOrigins(runtime), ...parseOrigins(build)])
  return `frame-ancestors 'self' ${[...origins].join(' ')}`.trim()
}

/**
 * A top-level page load, as opposed to a frame's document or the admin's own RSC fetches.
 * `Sec-Fetch-*` is sent by every current browser on HTTPS; without it nothing is assumed.
 */
export const isTopLevelNavigation = (headers: Headers): boolean =>
  headers.get('sec-fetch-dest') === 'document' && headers.get('sec-fetch-mode') === 'navigate'

/**
 * The embed's cookies are `Partitioned`, keyed on the *top-level site*. When the POS and the
 * CMS share a registrable domain (`admin.app.eshobe.com` / `cms.eshobe.com`) that key is the
 * same one a top-level visit to the CMS uses, so the modal's session — the site's embed
 * service user, the chrome-hiding marker and its tenant — is sent with the operator's own
 * cookies. Payload takes the later `payload-token`, so `/admin` opened as the embed user:
 * one customer's dashboard, no sidebar, no logout, and no platform access.
 *
 * A top-level navigation that carries the marker is therefore never an embed: this lists
 * the `Set-Cookie` values that drop the modal's copies. Same name, path and partition
 * (`Secure; SameSite=None; Partitioned`) as `serializeEmbedCookie`, so only the
 * partitioned cookies go and the operator's own session survives. On plain http (dev) the
 * embed cookies were never partitioned and already replaced the operator's; clearing them
 * signs out, which beats staying signed in as somebody else.
 *
 * The cost: an embed open in another tab loses its session and asks to be reopened.
 */
export const embedExitCookies = (tokenCookie: string, secure: boolean): string[] => {
  const attrs = secure ? 'Path=/; Max-Age=0; Secure; SameSite=None; Partitioned' : 'Path=/; Max-Age=0; SameSite=Lax'
  return [
    `${tokenCookie}=; ${attrs}`,
    `${TENANT_COOKIE}=; ${attrs}`,
    `${EMBED_MARKER_COOKIE}=; ${attrs}`,
    `${EMBED_EXIT_COOKIE}=1; Path=/; Max-Age=10; SameSite=Lax${secure ? '; Secure' : ''}`,
  ]
}
