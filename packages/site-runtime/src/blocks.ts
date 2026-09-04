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

export type SiteType = 'business' | 'portfolio' | 'store'

const ALL: SiteType[] = ['business', 'portfolio', 'store']

const library: { slug: string; siteTypes: SiteType[] }[] = [
  { slug: 'content', siteTypes: ALL },
  { slug: 'mediaBlock', siteTypes: ALL },
  { slug: 'cta', siteTypes: ALL },
  { slug: 'features', siteTypes: ALL },
  { slug: 'testimonials', siteTypes: ALL },
  { slug: 'faq', siteTypes: ALL },
  { slug: 'contact', siteTypes: ALL },
  { slug: 'formBlock', siteTypes: ALL },
  { slug: 'productGrid', siteTypes: ['store'] },
  { slug: 'gallery', siteTypes: ['portfolio', 'business'] },
  { slug: 'team', siteTypes: ['business', 'portfolio'] },
  { slug: 'pricing', siteTypes: ['business', 'store'] },
  { slug: 'logos', siteTypes: ['business', 'store'] },
  { slug: 'archive', siteTypes: ['business', 'portfolio'] },
]

export const siteBlocks: string[] = library.map(({ slug }) => slug)

export const blockSlugsForSiteType = (type: null | string | undefined): string[] =>
  library.filter(({ siteTypes }) => !type || siteTypes.includes(type as SiteType)).map(({ slug }) => slug)
