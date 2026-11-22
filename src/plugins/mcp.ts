import { mcpPlugin } from '@payloadcms/plugin-mcp'
import type { CollectionConfig } from 'payload'

import { mcpOverrideAuth } from '@/mcp/auth'
import {
  MCP_COLLECTION_CAPABILITIES,
  MCP_GLOBAL_CAPABILITIES,
  type McpCapability,
} from '@/mcp/capabilities'
import { mcpTools } from '@/mcp/tools'
import { MCP_COLLECTION_SLUGS } from '@/plugins/mcp-slugs'

/**
 * Per-collection descriptions. An LLM picks a tool from its description, so this is
 * the only place a client learns that `pages` is block-built and localized while
 * `store` is a singleton document.
 */
const DESCRIPTIONS: Partial<Record<(typeof MCP_COLLECTION_SLUGS)[number], string>> = {
  categories: 'Taxonomy shared by posts and products, per site and per locale.',
  footer: 'The site footer singleton: link columns, legal text and social links.',
  forms: 'Form definitions built with the form builder. Submissions are not exposed.',
  header: 'The site header singleton: logo, primary navigation and call to action.',
  media: 'Images and documents owned by this site. Find and update metadata; uploads are an editor action.',
  pages: 'Site pages built from blocks, with per-locale titles, slugs and SEO fields.',
  'payload-folders': 'Folders used to organise documents in the admin panel.',
  posts: 'Blog posts with per-locale content, categories and SEO fields.',
  products: 'Catalogue products for store sites, with prices in the site currency.',
  'site-branding': 'Brand identity: logo, colours and the site name used across the theme.',
  store: 'Store settings singleton: currency, checkout options and payment display.',
}

const capabilitiesFor = (slug: (typeof MCP_COLLECTION_SLUGS)[number]): McpCapability =>
  MCP_COLLECTION_CAPABILITIES[slug]

export const mcpCollectionCapabilities = Object.fromEntries(
  MCP_COLLECTION_SLUGS.map((slug) => [
    slug,
    { description: DESCRIPTIONS[slug], enabled: capabilitiesFor(slug) },
  ]),
) as Record<(typeof MCP_COLLECTION_SLUGS)[number], { description?: string; enabled: McpCapability }>

export const mcpGlobalCapabilities = MCP_GLOBAL_CAPABILITIES

/**
 * Instructions handed to every client at initialization. They answer the questions a
 * model otherwise guesses wrong: that nothing can be deleted, that writes are the
 * same writes the admin panel makes, and that a key belongs to exactly one site.
 */
const INSTRUCTIONS = [
  'This is the Eshobe CMS content API. Content belongs to one customer site, decided by the API key — no read accepts a site filter, and a site the key does not belong to is refused.',
  'Call cms_describe_capabilities first: it lists the collections and operations this key may use, with the exact tool names.',
  'Creating a document requires the `site` id, because a create has no existing document to read it from. Get it from cms_site_context, which returns only the sites this key may act on.',
  'There is no delete tool. Insert, edit and publish are available where the key allows; removal is an editor decision.',
  'Writes run through the same validation, hooks, quota checks and publish permission as the admin panel. A refused write is a business rule, not a transient error — do not retry it.',
  'Titles and slugs are localized. Pass the locale when reading or writing a translated field, and never assume the default-locale value exists for another locale.',
  'Deleting content, changing a domain, issuing credentials and platform administration are deliberately unreachable from here.',
].join('\n')

/**
 * Payload MCP — Model Context Protocol over `/api/mcp`.
 *
 * Wire contract and the reasoning behind the surface: `docs/mcp.md`.
 *
 * MCP API-key rows retain the plugin's safe default policy: authenticated users can
 * create their own key, only read/update/delete their own rows, and the `user` field
 * cannot be reassigned. The role attached to the key is therefore the real caller for
 * normal Payload access checks, including multi-tenant scoping. Never replace that with
 * platform-wide key management or `overrideAccess`.
 *
 * `expiresAt` and `mcpOverrideAuth` are the two additions to the plugin's defaults: a
 * key with a lifetime, and the request gate that enforces it plus a per-key rate and a
 * body-size cap (`src/mcp/limits.ts`).
 *
 * Deliberately no Caddy carve-out on customer domains. Credentials and capabilities
 * are enforced by this plugin plus collection access controls, not by a friendly UI.
 */
export const mcp = mcpPlugin({
  collections: mcpCollectionCapabilities,
  globals: mcpGlobalCapabilities,
  mcp: {
    handlerOptions: {
      // Streamable HTTP only. The SSE endpoint is a second, older transport with its
      // own session lifetime, and nothing in this deployment's clients needs it.
      disableSse: true,
      maxDuration: 60,
      verboseLogs: false,
    },
    serverOptions: {
      instructions: INSTRUCTIONS,
      serverInfo: {
        name: 'Eshobe CMS MCP',
        version: '1.1.0',
      },
    },
    tools: mcpTools,
  },
  overrideApiKeyCollection: (collection: CollectionConfig) => {
    collection.admin = {
      ...collection.admin,
      group: 'یکپارچه‌سازی',
    }
    collection.labels = {
      plural: 'کلیدهای MCP',
      singular: 'کلید MCP',
    }

    // The plugin ships no expiry. A machine credential with no lifetime is one that
    // outlives the integration it was minted for, and `mcpOverrideAuth` refuses an
    // expired key on its next request. Empty means "no expiry" — every key minted
    // before this field existed keeps working.
    if (!collection.fields.some((field) => 'name' in field && field.name === 'expiresAt')) {
      collection.fields.push({
        name: 'expiresAt',
        type: 'date',
        label: 'تاریخ انقضا',
        admin: {
          date: { pickerAppearance: 'dayAndTime' },
          description:
            'پس از این لحظه، هر درخواستی با این کلید با ۴۰۱ رد می‌شود. خالی یعنی بدون انقضا.',
          position: 'sidebar',
        },
      })
    }

    // Keep the plugin's per-user access rules and locked owner field intact.
    return collection
  },
  overrideAuth: mcpOverrideAuth,
})
