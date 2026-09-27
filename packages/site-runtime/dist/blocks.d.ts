/**
 * Block library metadata for the headless runtime.
 *
 * This is the runtime's view of `src/blocks/index.ts` — the slugs and the
 * per-site-type allowlist, without the Payload `Block` objects or `filterOptions`
 * (those require the database). A builder that imports this can decide whether
 * `productGrid` is allowed on a `business` site, or whether a saved page's layout
 * contains a block it does not know how to render, using the same table the
 * admin's picker uses.
 */
export type SiteType = 'business' | 'portfolio' | 'store';
export declare const siteBlocks: string[];
export declare const blockSlugsForSiteType: (type: null | string | undefined) => string[];
//# sourceMappingURL=blocks.d.ts.map