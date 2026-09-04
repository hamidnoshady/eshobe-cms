/**
 * Payload's own `slugify` is `replace(/[^\w-]+/g, '')` — `\w` is ASCII, so every
 * Persian character is stripped and "درباره ما" becomes "-". On a Persian-first
 * platform that is not cosmetic: every page an editor creates would collide on the
 * same one-character slug.
 *
 * Persian slugs are fine in a URL — the browser percent-encodes them and shows the
 * readable form back to the user.
 */
export const slugify = (value?: string | null): string =>
  (value ?? '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    // Arabic yeh/kaf look identical to the Persian letters but are a different
    // codepoint; two keyboards would otherwise produce two different slugs.
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    // Persian-Indic and Arabic-Indic digits → ASCII, so a slug can be typed.
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    // ZWNJ carries meaning inside a Persian word but cannot survive a URL.
    .replace(/[\s_‌]+/g, '-')
    // Any script's letters, digits and combining marks stay; punctuation goes.
    // `\p{M}` matters here: the hamza in "صفحهٔ" is a mark, not a letter.
    .replace(/[^\p{L}\p{M}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

/** Shape `slugField({ slugify })` expects. */
export const slugifyField = ({ valueToSlugify }: { valueToSlugify?: unknown }): string =>
  slugify(typeof valueToSlugify === 'string' ? valueToSlugify : '')

/**
 * The reserved slug of every site's home page, in every locale. Looking this up is
 * what makes bare `/` and bare `/en` resolve without a `homePage` field on `sites`.
 */
export const HOME_SLUG = 'home'

/**
 * A page slug as a site-relative path. The home page is `/`, never `/home` — two
 * URLs for one page splits its cache entry and its search ranking.
 */
export const pagePath = (slug?: string | null): string =>
  !slug || slug === HOME_SLUG ? '/' : `/${slug}`

/**
 * The blog's two routes are Next segments under `[domain]`, not CMS pages, so they
 * exist whether an editor likes it or not — and a static segment outranks the
 * `[domain]/[[...path]]` catch-all. A page saved as `posts` would therefore be
 * unreachable with no error anywhere: the URL would render the blog.
 *
 * Reserving them is `src/hooks/reservedPageSlug.ts`, and these three constants are
 * the single source for both halves — the routes and the validation cannot drift.
 */
export const POSTS_SEGMENT = 'posts'
export const SEARCH_SEGMENT = 'search'
export const CHECKOUT_SEGMENT = 'checkout'
export const PRODUCTS_SEGMENT = 'products'

export const POSTS_BASE = `/${POSTS_SEGMENT}`
export const SEARCH_PATH = `/${SEARCH_SEGMENT}`
export const CHECKOUT_BASE = `/${CHECKOUT_SEGMENT}`
export const PRODUCTS_BASE = `/${PRODUCTS_SEGMENT}`

/**
 * Everything `[domain]/[[...path]]` intercepts before the CMS is asked for a page.
 * Derived from the segments above, so reserving a route cannot be forgotten when one
 * is added.
 */
export const RESERVED_PAGE_SLUGS = [
  POSTS_SEGMENT,
  SEARCH_SEGMENT,
  CHECKOUT_SEGMENT,
] as const

/** A post's site-relative path. No locale segment here — `localeHref` adds that. */
export const postPath = (slug?: string | null): string =>
  slug ? `${POSTS_BASE}/${slug}` : POSTS_BASE

/** A product's site-relative path. No locale segment here — `localeHref` adds that. */
export const productPath = (slug?: string | null): string =>
  slug ? `${PRODUCTS_BASE}/${slug}` : PRODUCTS_BASE
