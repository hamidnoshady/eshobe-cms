import type { CollectionSlug } from 'payload'

/**
 * The intentionally small MCP surface. Sensitive operational rows, user/site
 * administration, submissions, credentials and deployment records are not MCP
 * resources at all; they cannot be enabled on a key by toggling a checkbox.
 */
export const MCP_COLLECTION_SLUGS = [
  'pages',
  'posts',
  'media',
  'categories',
  'site-branding',
  'header',
  'footer',
  'products',
  'store',
  'forms',
  'payload-folders',
] as const satisfies readonly CollectionSlug[]

/** There are no platform-wide globals available to MCP clients. */
export const MCP_GLOBAL_SLUGS = [] as const
