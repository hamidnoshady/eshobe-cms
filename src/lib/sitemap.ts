/**
 * Per-site `sitemap.xml` and `robots.txt`, built as strings so they can be unit
 * tested without a request, a database or a rendered page.
 *
 * One deployment serves many domains, so a build-time sitemap (`next-sitemap`, which
 * this replaces) cannot work: it writes one file, for one origin, at build time,
 * from a site list that does not exist until a customer is created. Both documents
 * are per-request and per-site, and their contents are per locale.
 */

/** `&`, `<`, `>`, `"` and `'` are the five characters XML cannot carry raw. */
export const escapeXml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '"': '&quot;', '&': '&amp;', "'": '&apos;', '<': '&lt;', '>': '&gt;' })[char] as string,
  )

export type SitemapEntry = {
  /**
   * Every locale the same document is reachable in, this one included. Search
   * engines want the set to be reciprocal — each URL listing every URL — which is
   * why the entry carries the whole group rather than "the other locales".
   */
  alternates?: { hreflang: string; href: string }[]
  lastmod?: null | string
  loc: string
}

const alternateTag = ({ href, hreflang }: { href: string; hreflang: string }): string =>
  `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}" />`

const urlTag = ({ alternates = [], lastmod, loc }: SitemapEntry): string =>
  [
    '  <url>',
    `    <loc>${escapeXml(loc)}</loc>`,
    ...(lastmod ? [`    <lastmod>${escapeXml(lastmod)}</lastmod>`] : []),
    ...alternates.map(alternateTag),
    '  </url>',
  ].join('\n')

/**
 * The `xhtml` namespace declaration is not decoration: without it the
 * `<xhtml:link>` alternates are an undeclared prefix, which makes the document
 * malformed XML and the whole sitemap unreadable — not just the alternates.
 */
export const sitemapXml = (entries: SitemapEntry[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries.map(urlTag),
    '</urlset>',
    '',
  ].join('\n')

/**
 * `robots.txt` for one customer domain.
 *
 * `/admin` and `/api` are already 404 on a customer host (Caddy, PLAN §5) — they are
 * listed anyway because a crawler that has learnt the URL from somewhere else should
 * not spend the site's crawl budget confirming it. `/next/` is the preview
 * handshake, which is authenticated and must never be indexed.
 *
 * An unknown or suspended host gets a blanket `Disallow: /`: it serves 404s, and a
 * crawler should stop rather than keep asking.
 */
export const robotsTxt = ({
  disallowAll = false,
  sitemapUrl,
}: {
  disallowAll?: boolean
  sitemapUrl?: null | string
}): string => {
  const lines = ['User-agent: *']

  if (disallowAll) {
    lines.push('Disallow: /')
  } else {
    lines.push('Disallow: /admin', 'Disallow: /api', 'Disallow: /next/', 'Allow: /')
    if (sitemapUrl) lines.push('', `Sitemap: ${sitemapUrl}`)
  }

  return `${lines.join('\n')}\n`
}
