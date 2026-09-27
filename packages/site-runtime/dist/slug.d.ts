/**
 * Payload's own `slugify` is `replace(/[^\w-]+/g, '')` — `\w` is ASCII, so every
 * Persian character is stripped and "درباره ما" becomes "-". On a Persian-first
 * platform that is not cosmetic: every page an editor creates would collide on the
 * same one-character slug.
 *
 * Persian slugs are fine in a URL — the browser percent-encodes them and shows the
 * readable form back to the user.
 */
export declare const slugify: (value?: string | null) => string;
/** Shape `slugField({ slugify })` expects. */
export declare const slugifyField: ({ valueToSlugify }: {
    valueToSlugify?: unknown;
}) => string;
/**
 * The reserved slug of every site's home page, in every locale. Looking this up is
 * what makes bare `/` and bare `/en` resolve without a `homePage` field on `sites`.
 */
export declare const HOME_SLUG = "home";
/**
 * A page slug as a site-relative path. The home page is `/`, never `/home` — two
 * URLs for one page splits its cache entry and its search ranking.
 */
export declare const pagePath: (slug?: string | null) => string;
/**
 * The blog's two routes are Next segments under `[domain]`, not CMS pages, so they
 * exist whether an editor likes it or not — and a static segment outranks the
 * `[domain]/[[...path]]` catch-all. A page saved as `posts` would therefore be
 * unreachable with no error anywhere: the URL would render the blog.
 *
 * Reserving them is `src/hooks/reservedPageSlug.ts`, and these three constants are
 * the single source for both halves — the routes and the validation cannot drift.
 */
export declare const POSTS_SEGMENT = "posts";
export declare const SEARCH_SEGMENT = "search";
export declare const CHECKOUT_SEGMENT = "checkout";
export declare const PRODUCTS_SEGMENT = "products";
export declare const POSTS_BASE = "/posts";
export declare const SEARCH_PATH = "/search";
export declare const CHECKOUT_BASE = "/checkout";
export declare const PRODUCTS_BASE = "/products";
/**
 * Everything `[domain]/[[...path]]` intercepts before the CMS is asked for a page.
 * Derived from the segments above, so reserving a route cannot be forgotten when one
 * is added.
 */
export declare const RESERVED_PAGE_SLUGS: readonly ["posts", "search", "checkout"];
/** A post's site-relative path. No locale segment here — `localeHref` adds that. */
export declare const postPath: (slug?: string | null) => string;
/** A product's site-relative path. No locale segment here — `localeHref` adds that. */
export declare const productPath: (slug?: string | null) => string;
//# sourceMappingURL=slug.d.ts.map