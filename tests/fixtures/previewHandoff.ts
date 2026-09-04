/**
 * Preview + admin handoff — builder-side contract fixture (WAVE-9 §4.2, §9.6)
 *
 * The CMS and the builder are two origins. `Host` routes every CMS request
 * (`src/proxy.ts`), but the builder has no customer `Host` — it is a third app
 * on its own domain. Two handoffs make that work and both channel through the
 * *CMS* origin so cookies land where the CMS reads them:
 *
 *   1. **Site preview** (`src/app/(site)/next/preview/route.ts`): the builder
 *      renders a draft. It obtains a `payload-token` for an editor and redirects
 *      the human browser via the CMS:
 *
 *        GET {cmsOrigin}/next/preview?path=/&previewSecret=…&token=…
 *
 *      The CMS host resolves the site from `Host` (the builder forwards the
 *      tenant domain — see `siteHeader`). The CMS route verifies the token via
 *      `payload.auth` (`cookie: payload-token=…` — no header), checks the
 *      shared `PREVIEW_SECRET`, enables Next draft mode, mirrors the token on
 *      `Host` (`SameSite=None; Secure; Partitioned`) so the subsequent page
 *      render authenticates the preview (access layer sees the editor), and
 *      307s to `path`. The builder's job is just to build that URL — this
 *      fixture is that URL.
 *
 *   2. **Admin handoff** (`src/endpoints/handoff.ts` — `GET|POST /api/handoff`):
 *      the builder lands an editor in `/admin` without a second login. Same
 *      shape, different target: `GET {cmsOrigin}/api/handoff?token=…&redirect=/admin`
 *      verifies the JWT, sets `payload-token` on the CMS origin with
 *      `SameSite=None`, and 302s to `redirect`. `POST` is the same with JSON
 *      `{ token, redirect }` + optional `Authorization: Bearer`.
 *
 * Both set the cookie on the CMS origin because that is the only origin whose
 * cookies Payload trusts — an `apiKey`-style `Authorization` header reaches
 * Payload's REST layer but not the draft/tenant path that `Host`+`payload-token`
 * reaches (and the page render is a `GET` with no header slot at all).
 *
 * The CMS asserts the invariant; the builder imports this fixture and calls
 * `buildSitePreviewUrl` / `buildAdminHandoffUrl` rather than re-deriving it.
 *
 * @see `src/app/(site)/next/preview/route.ts` — site preview source of truth
 * @see `src/endpoints/handoff.ts` — admin handoff source of truth
 * @see `WAVE-9.md` §4.2
 * @see `tests/int/preview-handoff.int.spec.ts` — integration test that pins the
 *   same table against a real Paylaod boot
 */

export type SitePreviewArgs = {
  cmsOrigin: string
  path: string
  previewSecret: string
  siteDomain: string
  token: string
}

export type AdminHandoffArgs = {
  cmsOrigin: string
  redirect?: string
  secret?: string
  token: string
}

/**
 * Site-tenant header (`src/lib/site-route.ts:siteHeader`). The tenant is a
 * `Host`; every host-scoped query and every `/next/preview` page render keys
 * on it. The builder forwards the site's domain as this header when it calls the
 * CMS as itself, and bakes it into the preview URL when it sends the *browser*
 * to the CMS.
 */
export const siteHeader = 'x-eshobe-site'

export const buildSitePreviewUrl = ({ cmsOrigin, path, previewSecret, siteDomain, token }: SitePreviewArgs): string => {
  const url = new URL('/next/preview', cmsOrigin)
  url.searchParams.set('path', path)
  url.searchParams.set('previewSecret', previewSecret)
  url.searchParams.set('token', token)
  // The browser will request this URL on the CMS origin; the builder's
  // `Host` for that request is the CMS host, not the tenant's. The tenant
  // is carried either as the `Host` itself (when the customer domain *is*
  // the CMS origin for local dev) or as `x-eshobe-site`. The CMS preview
  // route prefers `x-eshobe-site` then `Host`, same as `siteFromRequest`.
  // Callers that go through the CMS domain directly need only the URL;
  // callers that proxy through the builder add the header alongside.
  // Keeping `siteDomain` in the type makes the tenant explicit at call
  // sites even when the URL alone would resolve on local dev.
  void siteDomain
  return url.toString()
}

export const buildSitePreviewHeaders = (siteDomain: string): Record<string, string> => ({
  [siteHeader]: siteDomain,
})

export const buildAdminHandoffUrl = ({ cmsOrigin, redirect = '/admin', secret, token }: AdminHandoffArgs): string => {
  const url = new URL('/api/handoff', cmsOrigin)
  url.searchParams.set('token', token)
  url.searchParams.set('redirect', redirect)
  if (secret) url.searchParams.set('secret', secret)
  return url.toString()
}

export const buildAdminHandoffRequest = ({ cmsOrigin, redirect, secret, token }: AdminHandoffArgs): Request => {
  const url = buildAdminHandoffUrl({ cmsOrigin, redirect, secret, token })
  return new Request(url, { headers: { authorization: `Bearer ${token}` } })
}
