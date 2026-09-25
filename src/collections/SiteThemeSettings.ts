import type { CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'
import { themeSettingsGetEndpoint, themeSettingsSaveEndpoint } from '@/endpoints/themeSettings'

import { encryptThemeSettings, maskDeploySecret } from './hooks/deploySecrets'

/**
 * The tenant's answers to the variables a theme manifest declares
 * `source: "tenant"` — a map key, an external analytics id, a font licence.
 *
 * ## Why this is a separate document from `site-deployments`
 *
 * Two reasons, and the first is the one that matters. **Re-deploying must not rewrite
 * the customer's own values.** A deployment row is created fresh on every redeploy
 * and rollback; if these lived on it, switching a theme version would silently blank
 * every setting the customer entered. They belong to the *site and package*, not to
 * one run of one build.
 *
 * The second: who may write differs. A customer's owner answers these (it is their
 * map key). Nobody outside platform staff may touch `appUuid` or `status`.
 *
 * ## Customers write through `/current`, never through the raw collection
 *
 * `create`/`update` on the collection itself are platform-only. The raw form would let
 * a customer name any package and store any key; the customer surface is the
 * «تنظیمات پوسته» tab on their site, backed by `GET|POST
 * /api/site-theme-settings/current` (`src/endpoints/themeSettings.ts`), which takes the
 * package from the site's own deployments, accepts only the keys the manifest asked
 * the tenant for, and writes with `overrideAccess` after validating. `read` stays
 * `authenticated` — narrowed by the multi-tenant plugin to the caller's own site.
 *
 * ## Two columns, because two lifetimes
 *
 * `values` is plaintext JSON — the non-secret answers, readable in the admin so
 * support can see what is set. `secretValues` is one AES-256-GCM blob for the
 * variables the manifest marked `secret: true`: encrypted on write, masked on every
 * read unless the deploy job's own context flag is set, and never returned by any
 * API. The same three layers as every other stored secret here.
 *
 * One encrypted blob rather than a column per variable, deliberately: the variable
 * set is defined by a third-party manifest and changes when the theme is synced. A
 * schema a repository can alter is a migration a repository can trigger.
 */
export const SiteThemeSettings: CollectionConfig<'site-theme-settings'> = {
  slug: 'site-theme-settings',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    read: authenticated,
    update: platformAdmin,
  },
  admin: {
    defaultColumns: ['site', 'themePackage', 'updatedAt'],
    description:
      'مقادیری که هر پوسته از سایت می‌خواهد — مثل کلید نقشه. مشتری آن‌ها را از زبانهٔ «تنظیمات پوسته» روی سایت خودش وارد می‌کند؛ مقدار محرمانه رمزنگاری‌شده ذخیره می‌شود و دیگر نمایش داده نمی‌شود.',
    group: PLATFORM_GROUPS.product,
    hidden: hiddenFromCustomers,
    useAsTitle: 'id',
  },
  endpoints: [themeSettingsGetEndpoint, themeSettingsSaveEndpoint],
  labels: { plural: 'تنظیمات پوسته', singular: 'تنظیمات پوسته' },
  fields: [
    {
      name: 'themePackage',
      type: 'relationship',
      relationTo: 'theme-packages',
      label: 'پوسته',
      required: true,
      index: true,
    },
    {
      name: 'values',
      type: 'json',
      label: 'مقادیر',
      admin: {
        description: 'مقادیر غیرمحرمانه، به شکل {"MAP_API_KEY": "..."}. کلیدهای تعریف‌نشده نادیده گرفته می‌شوند.',
      },
    },
    {
      name: 'secretValues',
      type: 'text',
      label: 'مقادیر محرمانه',
      access: { read: () => false },
      admin: { hidden: true },
      hooks: { afterRead: [maskDeploySecret()] },
    },
  ],
  hooks: {
    beforeChange: [encryptThemeSettings],
  },
  timestamps: true,
}
