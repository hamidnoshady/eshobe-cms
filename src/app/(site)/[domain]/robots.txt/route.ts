import { robotsTxt } from '@/lib/sitemap'
import { getSiteContext } from '@/lib/site-context'
import { siteOrigin } from '@/lib/site-url'

/**
 * `https://acme.com/robots.txt`, per customer domain.
 *
 * The `Sitemap:` line has to name this site's own absolute URL — a crawler on
 * `acme.com` must never be pointed at another tenant's sitemap, which is exactly
 * what a single build-time `robots.txt` (one `siteUrl`, baked in) would do.
 */
export async function GET(): Promise<Response> {
  const { site } = await getSiteContext()

  const body = site
    ? robotsTxt({ sitemapUrl: `${siteOrigin(site)}/sitemap.xml` })
    : // Unknown, suspended or archived host: every path is a 404, so tell crawlers
      // to stop instead of letting them map the 404s.
      robotsTxt({ disallowAll: true })

  return new Response(body, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}
