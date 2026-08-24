import { formBuilderPlugin } from '@payloadcms/plugin-form-builder'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { nestedDocsPlugin } from '@payloadcms/plugin-nested-docs'
import { redirectsPlugin } from '@payloadcms/plugin-redirects'
import { seoPlugin } from '@payloadcms/plugin-seo'
import { searchPlugin } from '@payloadcms/plugin-search'
import { Plugin } from 'payload'
import { revalidateRedirects } from '@/hooks/revalidateRedirects'
import { GenerateTitle, GenerateURL } from '@payloadcms/plugin-seo/types'
import { FixedToolbarFeature, HeadingFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import { searchFields } from '@/search/fieldOverrides'
import { beforeSyncWithSearch } from '@/search/beforeSync'

import type { Config, Page, Post } from '@/payload-types'

import { isPlatformAdmin, platformAdminFieldAccess } from '@/access/platformAdmin'
import { getServerSideURL } from '@/utilities/getURL'

const generateTitle: GenerateTitle<Post | Page> = ({ doc }) => doc?.title ?? ''

const generateURL: GenerateURL<Post | Page> = ({ doc }) => {
  const url = getServerSideURL()

  return doc?.slug ? `${url}/${doc.slug}` : url
}

export const plugins: Plugin[] = [
  redirectsPlugin({
    collections: ['pages', 'posts'],
    overrides: {
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
      labels: {
        singular: 'پاسخ فرم',
        plural: 'پاسخ‌های فرم',
      },
      hooks: {
        beforeValidate: [
          async ({ data, req }) => {
            if (!data || data.site) return data

            // The tenant field is required and normally defaults from the admin's
            // tenant cookie — a public form POST has no cookie, so without this
            // every submission fails validation. The form itself knows its site.
            const formId = typeof data.form === 'object' ? data.form?.id : data.form
            if (!formId) return data

            const form = await req.payload.findByID({
              id: String(formId),
              collection: 'forms',
              depth: 0,
              disableErrors: true,
              overrideAccess: true,
              req,
            })

            return { ...data, site: (form as { site?: unknown } | null)?.site }
          },
        ],
      },
    },
    formOverrides: {
      labels: {
        singular: 'فرم',
        plural: 'فرم‌ها',
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
      pages: {},
      posts: {},
      redirects: {},
      search: {},
      // One document per site, edited like a global. Payload globals are
      // platform-wide singletons and cannot be tenant-scoped.
      footer: { isGlobal: true },
      header: { isGlobal: true },
      theme: { isGlobal: true },
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
]
