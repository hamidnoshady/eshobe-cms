/**
 * @eshobe/site-runtime — the contract a headless renderer can import instead of
 * re-implementing. Persian-first formatting, money, theming and the block allowlist.
 *
 * Importing this rather than copying `src/lib/format.ts` is how a second app avoids
 * an English date on a Persian homepage, a Latin digit on a price, or a palette that
 * ignores the site's brand. See `WAVE-9.md` §3 and §5.
 */
export * from './digits.js';
export * from './money.js';
export * from './format.js';
export * from './theme.js';
export * from './blocks.js';
export * from './slug.js';
export * from './locale.js';
export const contractVersion = 1;
//# sourceMappingURL=index.js.map