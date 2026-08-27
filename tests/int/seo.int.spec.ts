import { describe, expect, it } from 'vitest'

import type { Site } from '@/payload-types'

import { alternateUrls } from '@/lib/alternates'
import { localeHref } from '@/lib/locales'
import { robotsTxt, sitemapXml, escapeXml } from '@/lib/sitemap'
import { siteUrl } from '@/lib/site-url'

/**
 * Wave 6's SEO surface: what a crawler on a customer domain is told.
 *
 * These are the assertions that would otherwise only be caught by a search engine
 * indexing the wrong tenant, months later.
 */

/** Only the three fields a URL is built from; `Site` types the locale unions. */
type UrlSite = Pick<Site, 'availableLocales' | 'defaultLocale' | 'domain'>

const acme: UrlSite = {
  availableLocales: ['fa', 'en'],
  defaultLocale: 'fa',
  domain: 'acme.example.com',
}

const studio: UrlSite = {
  availableLocales: ['fa'],
  defaultLocale: 'fa',
  domain: 'studio.example.com',
}

describe('hreflang alternates', () => {
  it('lists every locale the document is translated into, plus x-default', () => {
    const urls = alternateUrls(acme, { en: 'about-us', fa: 'درباره-ما' })

    expect(urls).toEqual({
      en: 'http://acme.example.com:3000/en/about-us',
      fa: 'http://acme.example.com:3000/درباره-ما',
      'x-default': 'http://acme.example.com:3000/درباره-ما',
    })
  })

  it('omits a locale the document is not translated into', () => {
    // The whole reason `localeSlugs` reads with `fallbackLocale: false`: with the
    // fallback on, `en` would hold the Persian slug and this would advertise
    // `/en/درباره-ما`, which the slug lookup 404s.
    expect(alternateUrls(acme, { en: null, fa: 'درباره-ما' })).toEqual({
      fa: 'http://acme.example.com:3000/درباره-ما',
      'x-default': 'http://acme.example.com:3000/درباره-ما',
    })
  })

  it('never advertises a locale the site does not serve', () => {
    expect(alternateUrls(studio, { en: 'about-us', fa: 'درباره-ما' })).toEqual({
      fa: 'http://studio.example.com:3000/درباره-ما',
      'x-default': 'http://studio.example.com:3000/درباره-ما',
    })
  })

  it('falls back to a translated locale when the default one is missing', () => {
    expect(alternateUrls(acme, { en: 'about-us', fa: null })['x-default']).toBe(
      'http://acme.example.com:3000/en/about-us',
    )
  })

  it('returns nothing for an untranslated document rather than a bare origin', () => {
    expect(alternateUrls(acme, {})).toEqual({})
  })
})

describe('home page URLs', () => {
  it('has no trailing slash, in either locale', () => {
    // `/en/` and `/en` are one page on two URLs; Next redirects one to the other,
    // and a canonical or sitemap entry that points at the redirect wastes it.
    expect(siteUrl(acme, { locale: 'fa', slug: 'home' })).toBe('http://acme.example.com:3000')
    expect(siteUrl(acme, { locale: 'en', slug: 'home' })).toBe('http://acme.example.com:3000/en')
    expect(localeHref('/', 'en', 'fa')).toBe('/en')
  })
})

describe('sitemap.xml', () => {
  it('declares the xhtml namespace it uses for alternates', () => {
    const xml = sitemapXml([
      {
        alternates: [{ href: 'https://acme.example.com/en/a', hreflang: 'en' }],
        loc: 'https://acme.example.com/a',
      },
    ])

    // Without the declaration the `xhtml:` prefix is undefined and the *whole*
    // document is malformed, not just the alternate.
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="en"')
  })

  it('escapes the five XML characters', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f')
    expect(sitemapXml([{ loc: 'https://acme.example.com/a?b=1&c=2' }])).toContain('&amp;c=2')
  })

  it('omits lastmod when the document has none', () => {
    expect(sitemapXml([{ loc: 'https://acme.example.com/a' }])).not.toContain('lastmod')
  })
})

describe('robots.txt', () => {
  it('points at this site’s own sitemap', () => {
    const body = robotsTxt({ sitemapUrl: 'https://acme.example.com/sitemap.xml' })

    // A single build-time robots.txt named one origin for every tenant. This is the
    // regression that replaced it.
    expect(body).toContain('Sitemap: https://acme.example.com/sitemap.xml')
    expect(body).toContain('Disallow: /admin')
  })

  it('tells crawlers to stop on an unknown host', () => {
    const body = robotsTxt({ disallowAll: true })

    expect(body).toBe('User-agent: *\nDisallow: /\n')
    expect(body).not.toContain('Sitemap:')
  })
})
