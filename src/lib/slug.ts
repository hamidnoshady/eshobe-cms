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
