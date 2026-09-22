import type { CollectionConfig } from 'payload'

import { authenticated } from '@/access/authenticated'
import { platformAdmin } from '@/access/platformAdmin'
import { hiddenFromCustomers, PLATFORM_GROUPS } from '@/admin/visibility'

import { encryptThemeSettings } from './hooks/deploySecrets'

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
 * The second: field access differs. A customer's staff may write these (it is their
 * map key). Nobody outside platform staff may touch `appUuid` or `status`. One
 * document cannot hold both rules cleanly.
 *
 * ## Two columns, because two lifetimes
 *
 * `values` is plaintext JSON — the non-secret answers, readable in the admin so
 * support can see what is set. `secretValues` is one AES-256-GCM blob for the
 * variables the manifest marked `secret: true`, never returned by anything.
 *
 * One encrypted blob rather than a column per variable, deliberately: the variable
 * set is defined by a third-party manifest and changes when the theme is synced. A
 * schema a repository can alter is a migration a repository can trigger.
 */
export const SiteThemeSettings: CollectionConfig<'site-theme-settings'> = {
  slug: 'site-theme-settings',
  access: {
    // A site's own staff maintain these; the multi-tenant plugin narrows every one of
    // these to the caller's site, so `authenticated` here means "this site's staff".
    create: authenticated,
    delete: platformAdmin,
    read: authenticated,
    update: authenticated,
  },
  admin: {
    defaultColumns: ['site', 'themePackage', 'updatedAt'],
    description:
      'مقادیری که این پوسته از شما می‌خواهد — مثل کلید نقشه. فهرست متغیرها را خود پوسته تعیین می‌کند؛ مقدار محرمانه رمزنگاری‌شده ذخیره می‌شود و دیگر نمایش داده نمی‌شود.',
    group: PLATFORM_GROUPS.extensions,
    hidden: hiddenFromCustomers,
    useAsTitle: 'id',
  },
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
    },
  ],
  hooks: {
    beforeChange: [encryptThemeSettings],
  },
  timestamps: true,
}
