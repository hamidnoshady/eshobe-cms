import { NextResponse, type NextRequest } from 'next/server'

import { defaultLocale, isLocale } from '@/lib/locales'

/**
 * Turns a request on a customer domain into a route under `[domain]`:
 * `acme.localhost/en/about` → `/acme.localhost/en/about`.
 *
 * `proxy.ts`, not `middleware.ts`: Next 16 deprecated that filename and warns on
 * every boot. Same contract, same `config.matcher`, exported as `proxy`.
 *
 * PLAN §5 put this in `next.config`'s `rewrites()`. It lives here instead because
 * `x-locale` already requires an interception on every request, so the rewrite is
 * one extra call in code that runs anyway — cheaper than a second host-matching
 * regex in another file, and the locale and the domain are parsed from the same
 * segments.
 *
 * `x-locale` exists because `<html lang dir>` is set in the root layout, which sits
 * above `[domain]` and receives no params. Direction is per-locale, so it has to be
 * resolved server-side or the page flashes the wrong direction on load.
 */
export const config = {
  /**
   * Everything except Payload's own API and static assets. `/api` must stay
   * untouched or Payload's routes disappear; blocking it on customer domains is the
   * proxy's job (PLAN §5), not app code's. `/media` is served from `public/` —
   * static files are resolved after middleware, so a rewrite 404s them.
   *
   * `robots.txt` and `sitemap.xml` are deliberately *not* excluded any more. They
   * used to be, back when `next-sitemap` wrote them into `public/` at build time —
   * one file, one origin, for a deployment that serves many. They are now per-site
   * route handlers under `[domain]`, so they have to go through the host rewrite
   * like every other page; excluding them serves 404s.
   *
   * `/admin` is matched but never rewritten — see `adminLanguage`.
   */
  matcher: ['/((?!api|next|_next|media|favicon).*)'],
}

/** Payload's admin-language cookie. `cookiePrefix` is left at its default. */
const LANGUAGE_COOKIE = 'payload-lng'

/**
 * Payload picks the admin's language from `payload-lng`, then `Accept-Language`,
 * then `i18n.fallbackLanguage` — so on a Persian-first platform an editor whose
 * Windows advertises `en-US` (most of them) gets an English admin, and
 * `fallbackLanguage: 'fa'` never gets a say.
 *
 * Setting the cookie only when it is absent makes Persian the default and leaves
 * the account's own language selector — which writes the same cookie — in charge.
 */
const adminLanguage = (req: NextRequest): NextResponse => {
  if (req.cookies.has(LANGUAGE_COOKIE)) return NextResponse.next()

  // On the request as well as the response: Payload reads the cookie while rendering
  // *this* request, so a response-only cookie would serve one English admin page
  // before taking effect.
  req.cookies.set(LANGUAGE_COOKIE, defaultLocale)

  const res = NextResponse.next({ request: { headers: req.headers } })
  res.cookies.set(LANGUAGE_COOKIE, defaultLocale, { path: '/', sameSite: 'lax' })

  return res
}

export function proxy(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith('/admin')) return adminLanguage(req)

  // `Host` carries the port in dev; `sites.domain` never does.
  const host = (req.headers.get('host') ?? '').split(':')[0]!.toLowerCase()

  const segments = req.nextUrl.pathname.split('/').filter(Boolean)
  // Bare `/` and `/about` have no locale segment — the site's own default applies,
  // resolved in `getSiteContext` where the site is known.
  const locale = isLocale(segments[0]) ? segments[0]! : ''

  const headers = new Headers(req.headers)
  // Unconditionally, not `if (locale)`: the header is copied from the incoming
  // request, so leaving it alone on an unprefixed path let a client send its own
  // `x-locale` and pick the rendered locale behind the URL's back.
  headers.set('x-locale', locale)

  const url = req.nextUrl.clone()
  url.pathname = `/${host}${req.nextUrl.pathname}`

  return NextResponse.rewrite(url, { request: { headers } })
}
