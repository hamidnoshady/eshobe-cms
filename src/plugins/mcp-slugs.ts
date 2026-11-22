import type { CollectionSlug } from 'payload'

/**
 * The intentionally closed MCP surface.
 *
 * Tenant staff manage their own site through the admin panel; MCP lets an
 * assistant do the same work under the same access rules. So the surface is the
 * tenant's *content* and *design*, not the platform's operation:
 *
 *  - everything a site's editor owns is here — pages, posts, media, products,
 *    navigation, theme, custom content types and their entries, taxonomies,
 *    comments, folders, store settings — plus read-only visibility of the site
 *    record and its orders;
 *  - platform-wide rows are not MCP resources at all: `users`, `api-keys`,
 *    `storage-connections`, `payment-gateways`, billing, `webhooks`, `audit-log`,
 *    `form-submissions`, `site-theme-settings` (secret answers) and every
 *    deployment/theme-package table. An unregistered collection cannot be enabled
 *    by ticking a checkbox, and a platform admin's key gains no extra reach here.
 */
export const MCP_COLLECTION_SLUGS = [
  'pages',
  'posts',
  'media',
  'categories',
  'menus',
  'comments',
  'products',
  'store',
  'orders',
  'theme',
  'site-branding',
  'header',
  'footer',
  'content-type-definitions',
  'content-entries',
  'taxonomy-definitions',
  'taxonomy-terms',
  'entry-term-relations',
  'content-relations',
  'forms',
  'payload-folders',
  'sites',
] as const satisfies readonly CollectionSlug[]

/** There are no platform-wide globals available to MCP clients. */
export const MCP_GLOBAL_SLUGS = [] as const
