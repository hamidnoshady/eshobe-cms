import { isLocale } from './locales'
import {
  CHECKOUT_SEGMENT,
  HOME_SLUG,
  POSTS_SEGMENT,
  PRODUCTS_SEGMENT,
  SEARCH_SEGMENT,
} from './slug'

/**
 * What a URL under `[domain]` actually is.
 *
 * Every site route goes through here rather than becoming its own folder under
 * `[domain]`, and the reason is a Next.js matching detail that bites silently: the
 * locale segment lives *between* the domain and the route, so a static folder like
 * `[domain]/posts/page.tsx` matches `/posts` and **not** `/en/posts`. On a bilingual
 * site the English URL would then fall through to the page lookup, ask the CMS for a
 * page named `posts` under `en`… and 404 while the Persian one works. Two shapes of the
 * same URL, one working, is precisely the class of bug that ships because it looks
 * fine in dev on the default locale.
 *
 * One resolver, fed the already-locale-stripped segments, makes every route
 * locale-correct by construction. It is pure — no database, no `next/headers` — so the
 * rules below are unit-testable, which a route folder is not.
 */
export type SiteRoute =
  | { kind: 'checkout'; order: null | string }
  | { kind: 'page'; slug: string }
  | { kind: 'post'; slug: string }
  | { kind: 'posts' }
  | { kind: 'product'; slug: string }
  | { kind: 'search' }

export const resolveSiteRoute = (path: string[] = []): SiteRoute => {
  const segments = (isLocale(path[0]) ? path.slice(1) : path).map((segment) =>
    decodeURIComponent(segment),
  )

  const [first, second] = segments

  if (!first) return { kind: 'page', slug: HOME_SLUG }

  if (first === POSTS_SEGMENT) {
    return second ? { kind: 'post', slug: second } : { kind: 'posts' }
  }

  if (first === SEARCH_SEGMENT && segments.length === 1) return { kind: 'search' }

  if (first === PRODUCTS_SEGMENT) {
    return second ? { kind: 'product', slug: second } : { kind: 'page', slug: 'products' }
  }

  if (first === CHECKOUT_SEGMENT && segments.length <= 2) {
    return { kind: 'checkout', order: second ?? null }
  }

  /**
   * Joined, not `first`: the CMS has always resolved a page by its whole remaining
   * path, so a site whose editor typed a nested slug keeps working. Anything that
   * does not match a route above is the CMS's business, and an unknown slug is a 404
   * from the page lookup — not a 404 from here, which would deny the site its own
   * reserved-word pages (a post *about* search is still at `/search`-adjacent… no:
   * `/search` is taken, which is why `RESERVED_PAGE_SLUGS` exists).
   */
  return { kind: 'page', slug: segments.join('/') }
}
