/**
 * Platform locales. One source of truth: `payload.config.ts` feeds this to
 * `localization`, and the front end reads `rtl` from it to set `dir` per request.
 *
 * Each site serves a *subset* (`sites.locales`) — this is the full menu, not what
 * any one site offers. Adding a locale here also grows the admin bundle, so it is
 * deliberately short.
 */
export const locales = [
  { code: 'fa', label: 'فارسی', rtl: true },
  { code: 'en', label: 'English', rtl: false },
]

export const defaultLocale = 'fa'

export const localeCodes = locales.map(({ code }) => code)

export const isLocale = (value: unknown): boolean =>
  typeof value === 'string' && localeCodes.includes(value)

/** `dir` for the document element. Comes from the locale, never hardcoded. */
export const dirFor = (code: string): 'ltr' | 'rtl' =>
  locales.find((locale) => locale.code === code)?.rtl ? 'rtl' : 'ltr'

/**
 * A site-relative path in the active locale. The site's own default locale has no
 * prefix, so bare `/` and `/about` stay the canonical Persian URLs.
 *
 * External and anchor hrefs pass through untouched — prefixing `https://…` or
 * `#section` with a locale would break them.
 */
export const localeHref = (path: string, locale: string, siteDefault: string): string =>
  path.startsWith('/') && locale !== siteDefault
    ? // `/en`, not `/en/`: the home page's path is `/`, and naively concatenating
      // gives the one URL a trailing-slash twin that Next redirects away from —
      // fine to click, wrong to publish in a canonical tag or a sitemap.
      `/${locale}${path === '/' ? '' : path}`
    : path
