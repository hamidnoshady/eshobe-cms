/**
 * @eshobe/site-runtime — the contract a headless renderer can import instead of
 * re-implementing. Persian-first formatting, money, theming and the block allowlist.
 *
 * Importing this rather than copying `src/lib/format.ts` is how a second app avoids
 * an English date on a Persian homepage, a Latin digit on a price, or a palette that
 * ignores the site's brand. See `WAVE-9.md` §3 and §5.
 */

export * from './digits'
export * from './money'
export * from './format'
export * from './theme'
export * from './blocks'
export * from './slug'

export const contractVersion = 1 as const
