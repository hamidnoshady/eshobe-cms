import { formBuilderPlugin } from '@payloadcms/plugin-form-builder'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { nestedDocsPlugin } from '@payloadcms/plugin-nested-docs'
import { redirectsPlugin } from '@payloadcms/plugin-redirects'
import { seoPlugin } from '@payloadcms/plugin-seo'
import { searchPlugin } from '@payloadcms/plugin-search'
import type { Plugin } from 'payload'
import { revalidateRedirects } from '@/hooks/revalidateRedirects'
import { revalidateSiteGlobal, revalidateSiteGlobalDelete } from '@/hooks/revalidateSiteGlobal'
import { GenerateTitle, GenerateURL } from '@payloadcms/plugin-seo/types'
import { FixedToolbarFeature, HeadingFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import { searchFields } from '@/search/fieldOverrides'
import { beforeSyncWithSearch } from '@/search/beforeSync'

import type { Config, Page, Post } from '@/payload-types'

import { isPlatformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { hiddenFromOperators, SITE_CONTENT_GROUP } from '@/admin/visibility'
import { anyone } from '@/access/anyone'
import { authenticated } from '@/access/authenticated'
import { scopedPublicRead } from '@/access/siteRead'
import { idOf } from '@/lib/ids'
import {
  allowDerivedPublicFormSiteAssignment,
  enforcePublicFormSubmissionRateLimit,
  rejectPublicFormSubmission,
  restorePublicFormSiteAssignment,
  stripPublicFormHoneypot,
  verifyPublicFormChallenge,
} from '@/lib/form-submission-rate-limit'
import { jalaliDates } from './jalaliDates'
import { mcp } from './mcp'
import { publicReadLimits } from '@/lib/public-read-limits'
import { tenantMediaPicker } from '@/plugins/tenant-media-picker'
import { storage } from './storage'
import { siteUrlForDoc } from '@/lib/site-url'
import { getServerSideURL } from '@/utilities/getURL'

const generateTitle: GenerateTitle<Post | Page> = ({ doc }) => doc?.title ?? ''

/**
 * The URL the SEO tab previews as the search result.
 *
 * The template returned `${getServerSideURL()}/${slug}` — the admin's own origin,
 * no locale segment, and `/home` for the front page. Every one of those is wrong on
 * a platform where each site has its own domain, and it is the string the editor
 * checks their SEO against, so a wrong one teaches them the wrong URL.
 *
 * `req.locale` is whichever locale the tab is being edited in, so an English page
 * previews as `/en/about`.
 */
const generateURL: GenerateURL<Post | Page> = async ({ doc, req }) => {
  const target = await siteUrlForDoc({ doc, req })

  // Falls back to the deployment origin, not a guessed customer domain: this string
  // is shown to an editor, and a plausible-looking wrong domain is worse than an
  // obviously-internal one.
  return target ? target.origin + target.path : getServerSideURL()
}

export const plugins: Plugin[] = [
  // First, and before the multi-tenant plugin in particular: it rewrites `media`'s
  // fields and upload handlers, and it must not race the `site` field being added.
  storage,
  redirectsPlugin({
    collections: ['pages', 'posts'],
    overrides: {
      access: {
        // A redirect table is site config: `acme.ir/* → studio.ir/*` is not information
        // one customer should be able to read off another's domain, and a headless
        // renderer resolving a path must not be able to walk the platform's redirects.
        read: scopedPublicRead(authenticated),
      },
      admin: {
        group: SITE_CONTENT_GROUP,
        hidden: hiddenFromOperators,
      },
      labels: {
        singular: 'تغییر مسیر',
        plural: 'تغییر مسیرها',
      },
      // @ts-expect-error - This is a valid override, mapped fields don't resolve to the same type
      fields: ({ defaultFields }) => {
        return defaultFields.map((field) => {
          if ('name' in field && field.name === 'from') {
            return {
              ...field,
              admin: {
                description: 'برای اعمال این تغییر، سایت باید بازسازی شود.',
              },
            }
          }
          return field
        })
      },
      hooks: {
        afterChange: [revalidateRedirects],
      },
    },
  }),
  nestedDocsPlugin({
    collections: ['categories'],
    generateURL: (docs) => docs.reduce((url, doc) => `${url}/${doc.slug}`, ''),
  }),
  seoPlugin({
    generateTitle,
    generateURL,
  }),
  formBuilderPlugin({
    fields: {
      payment: false,
    },
    formSubmissionOverrides: {
      admin: {
        group: SITE_CONTENT_GROUP,
        hidden: hiddenFromOperators,
      },
      labels: {
        singular: 'پاسخ فرم',
        plural: 'پاسخ‌های فرم',
      },
      hooks: {
        beforeValidate: [
          async ({ data, req }) => {
            const { data: cleanData, filled } = stripPublicFormHoneypot(data)
            const record = cleanData && typeof cleanData === 'object'
              ? cleanData as Record<string, unknown>
              : undefined

            if (filled) {
              // A filled trap is charged to a bounded fallback bucket and gets one
              // generic refusal; neither the honeypot name nor site existence leaks.
              enforcePublicFormSubmissionRateLimit(req, null)
              rejectPublicFormSubmission()
            }

            if (!record) {
              enforcePublicFormSubmissionRateLimit(req, null)
              return cleanData
            }

            /**
             * The submission's site always comes from the form, never from the
             * request. Deriving it also lets the anonymous budget follow the real
             * tenant rather than a caller-controlled form ID or Host header.
             */
            const formValue = record.form
            const formId = formValue && typeof formValue === 'object'
              ? (formValue as { id?: unknown }).id
              : formValue
            if (!formId) {
              enforcePublicFormSubmissionRateLimit(req, null)
              return cleanData
            }

            const form = await req.payload.findByID({
              id: String(formId),
              collection: 'forms',
              depth: 0,
              disableErrors: true,
              // Reading the form only answers "which site owns this?" — the visitor
              // is anonymous by design and cannot be asked to have read access to it.
              overrideAccess: true,
              req,
              select: { site: true },
            })
            const formSite = (form as { site?: unknown } | null)?.site
            const siteID = idOf(formSite)
            enforcePublicFormSubmissionRateLimit(req, siteID)

            if (!siteID || !await verifyPublicFormChallenge({ data: record, req, siteID })) {
              rejectPublicFormSubmission()
            }

            // The tenant ID is resolved from this persisted form, never from the
            // submitted `site` value. Let the multi-tenant plugin validate this
            // server-derived assignment without treating an anonymous visitor as a
            // member of the site's editor team.
            allowDerivedPublicFormSiteAssignment(req, siteID)

            return { ...record, site: siteID }
          },
        ],
      },
    },
    formOverrides: {
      admin: {
        group: SITE_CONTENT_GROUP,
        hidden: hiddenFromOperators,
      },
      labels: {
        singular: 'فرم',
        plural: 'فرم‌ها',
      },
      hooks: {
        afterChange: [revalidateSiteGlobal('form')],
        afterDelete: [revalidateSiteGlobalDelete('form')],
      },
      fields: ({ defaultFields }) => {
        return defaultFields.map((field) => {
          if ('name' in field && field.name === 'confirmationMessage') {
            return {
              ...field,
              editor: lexicalEditor({
                features: ({ rootFeatures }) => {
                  return [
                    ...rootFeatures,
                    FixedToolbarFeature(),
                    HeadingFeature({ enabledHeadingSizes: ['h1', 'h2', 'h3', 'h4'] }),
                  ]
                },
              }),
            }
          }
          return field
        })
      },
    },
  }),
  searchPlugin({
    collections: ['posts'],
    beforeSync: beforeSyncWithSearch,
    searchOverrides: {
      access: {
        // The index is a copy of published content, but a *copy* — and it carries the
        // SEO descriptions of every indexed doc. Public and host-scoped, exactly like
        // the pages it mirrors, so search cannot become the side door around
        // `src/access/siteRead.ts`.
        read: scopedPublicRead(anyone),
      },
      admin: {
        group: SITE_CONTENT_GROUP,
        hidden: hiddenFromOperators,
      },
      labels: {
        singular: 'نتیجه جست‌وجو',
        plural: 'نتایج جست‌وجو',
      },
      fields: ({ defaultFields }) => {
        return [...defaultFields, ...searchFields]
      },
    },
  }),
  /**
   * Last on purpose: it adds the `site` field to the collections other plugins
   * create (`forms`, `form-submissions`, `search`, `redirects`), so those have to
   * exist by the time it runs.
   *
   * Any collection missing from `collections` below is shared by every tenant —
   * silently, with no error. Add new collections here in the same commit.
   */
  multiTenantPlugin<Config>({
    // Cascade-deletes every document a site owns. Sites are archived, not deleted.
    cleanupAfterTenantDelete: false,
    collections: {
      categories: {},
      forms: {},
      'form-submissions': {},
      media: {},
      // Media folders (`folders: true` on Media). Unregistered, every customer saw every
      // other customer's folder tree — and a folder's contents never rendered for a
      // tenant user: the admin lists them through a polymorphic join (`documentsAndFolders`)
      // that inherits Media's `site` read constraint, which a folder row with no `site`
      // can never satisfy, so every subfolder was saved and then invisible.
      'payload-folders': {},
      // Wave 7. A product and an order are as much a site's rows as a page is; an
      // unregistered collection is *shared* between every customer, silently.
      orders: {},
      // Wave 10. A gateway row holds a merchant's credentials *and* which site they
      // belong to, so this is the one collection where an unregistered entry would not
      // merely leak content — it would hand every tenant a form for every other tenant's
      // PSP account.
      'payment-gateways': {},
      // CDN credentials can rewrite a tenant's DNS and edge security. They are platform
      // admin-only, but still must carry `site`: tenant registration keeps an accidental
      // future access-policy relaxation from turning them into shared infrastructure.
      'cdn-zones': {},
      // Registrar domains, billable workflow rows and their audit events must carry the
      // same site boundary as content. Leaving even the event stream unregistered would
      // let one tenant infer another tenant's domain operations.
      'reseller-domains': {},
      'reseller-domain-operations': {},
      'reseller-domain-events': {},
      // The SaaS control plane's per-site rows. Every one of these is
      // platform-admin-only on `access`, so registration changes nothing a customer
      // can reach today — it is here for the reason CLAUDE.md gives: an unregistered
      // collection is *shared by every tenant, silently*, and a future access
      // relaxation on a subscription or a usage counter would then hand one
      // customer's commercial record to another.
      //
      // Rows are registered unless they are platform-owned catalogue/infrastructure:
      //
      //   - `plans`, `feature-flags`, `theme-packages`, `theme-artifacts`, `deploy-targets`,
      //     `plugins`, `webhooks` are the platform's own catalogue/build output and
      //     infrastructure — the same shape as `api-keys` and `storage-connections`.
      //     A `site` column on a price list or immutable theme build is meaningless.
      //   - `audit-log` and `webhook-deliveries` carry *optional* site references
      //     they declare themselves, because a platform-level action ("settings
      //     changed") belongs to no site. The plugin's `site` field is **required**
      //     by construction (`tenantField`'s validate), so registering them would
      //     make every platform-level audit row unsavable — and would collide with
      //     the `site` field `audit-log` already declares.
      subscriptions: {},
      invoices: {},
      'site-entitlements': { isGlobal: true },
      'usage-records': {},
      // Execution-plane billing. One projection and one storage clock per site.
      // Outbox and samples are per-site measurements. Credentials and replay
      // nonces are platform-wide and stay out of this map.
      'central-entitlement-projections': { isGlobal: true },
      'billing-storage-accounts': { isGlobal: true },
      'billing-usage-outbox': {},
      'billing-usage-samples': {},
      // The deployment surface splits the same way. `site-deployments`,
      // `theme-bindings`, and `site-theme-settings` each carry exactly one site, so
      // they are registered; `theme-packages`, `theme-artifacts`, and `deploy-targets`
      // are the operator's Theme catalogue, immutable build outputs, and server list,
      // so they take the documented exception. "Which customer owns the Tehran
      // server?" has no answer, and a required `site` column would make the row unsavable.
      'site-deployments': {},
      'theme-bindings': {},
      'site-theme-settings': { isGlobal: true },
      'site-branding': { isGlobal: true },
      pages: {},
      posts: {},
      products: {},
      redirects: {},
      search: {},
      // One document per site, edited like a global. Payload globals are
      // platform-wide singletons and cannot be tenant-scoped.
      footer: { isGlobal: true },
      header: { isGlobal: true },
      theme: { isGlobal: true },
      store: { isGlobal: true },
    },
    // Shows the `site` field in the admin UI, which is how you catch a document
    // that landed on the wrong tenant.
    debug: process.env.NODE_ENV === 'development',
    /**
     * The plugin's own word for a tenant is "مستاجر" — a lodger. On a platform
     * whose tenants are websites the selector has to read as "which site am I
     * editing?".
     *
     * This has to live here, not in `payload.config`'s `i18n.translations`: the
     * plugin *overwrites* its whole namespace there with these values spread on
     * top, so a config-level override is silently discarded.
     */
    i18n: {
      translations: {
        en: {
          'assign-tenant-button-label': 'Assign site',
          'assign-tenant-modal-title': 'Assign "{{title}}"',
          'field-assignedTenant-label': 'Assigned site',
          'nav-tenantSelector-label': 'Site',
        },
        fa: {
          'assign-tenant-button-label': 'اختصاص سایت',
          'assign-tenant-modal-title': 'اختصاص «{{title}}»',
          'field-assignedTenant-label': 'سایت اختصاص‌یافته',
          'nav-tenantSelector-label': 'سایت',
        },
      },
    },
    // 'tenant' reads as jargon in an app whose tenants are literally websites.
    tenantField: {
      name: 'site',
    },
    tenantsArrayField: {
      includeDefaultField: true,
      // Agency-first: only platform staff assign users to sites. Otherwise a
      // customer who can edit users could add themselves to another site.
      arrayFieldAccess: {
        create: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      tenantFieldAccess: {
        create: platformAdminFieldAccess,
        update: platformAdminFieldAccess,
      },
      rowFields: [
        {
          name: 'role',
          type: 'select',
          label: 'نقش',
          defaultValue: 'editor',
          required: true,
          options: [
            { label: 'مالک', value: 'owner' },
            { label: 'ویرایشگر', value: 'editor' },
          ],
        },
      ],
    },
    tenantsSlug: 'sites',
    userHasAccessToAllTenants: isPlatformAdmin,
  }),
  // Registers `payload-mcp-api-keys` and `/api/mcp`. After multi-tenant so every
  // tenant-scoped collection already exists in config.
  mcp,
  // These final plugins must see fields/collections/hooks every plugin above adds,
  // including the MCP key collection. Public reads remain capped; tenant-owned upload
  // fields then receive one reusable picker plus a server-side same-site relation guard.
  jalaliDates,
  publicReadLimits,
  tenantMediaPicker,
  // Must run after multiTenant's assignment validator and restore REST/GraphQL
  // mode before any field or after-change hooks observe the request.
  restorePublicFormSiteAssignment,
]
