import type { CollectionConfig } from 'payload'

import { slugField } from 'payload'

import { authenticated } from '../access/authenticated'
import { platformAdmin, platformAdminFieldAccess } from '../access/platformAdmin'
import { locales } from '../lib/locales'
import { slugifyField } from '../lib/slug'

/** Same list the platform offers, in select-field shape. */
const localeOptions = locales.map(({ code, label }) => ({ label, value: code }))

/**
 * A site is one customer website — and the multi-tenant plugin's tenant. Every
 * content collection carries a `site` field pointing here, so the admin's tenant
 * selector reads as "which site am I editing?".
 *
 * `delete` is platform-admin only: even with `cleanupAfterTenantDelete: false`,
 * removing a site orphans all of its content behind a dangling reference.
 */
export const Sites: CollectionConfig = {
  slug: 'sites',
  access: {
    create: platformAdmin,
    delete: platformAdmin,
    // The plugin narrows this to the user's own sites (`useTenantsCollectionAccess`).
    read: authenticated,
    update: authenticated,
  },
  admin: {
    defaultColumns: ['name', 'domain', 'domainVerified', 'type', 'status'],
    useAsTitle: 'name',
    components: {
      views: {
        /**
         * The Wave 5 "New site" action, as a custom view on the sites collection:
         * one form that creates the site, seeds it for its type and locales, and
         * invites the client's users — reached from the list header's button.
         */
        provision: {
          Component: '@/provisioning/AdminView',
          meta: {
            title: 'ساخت سایت جدید',
          },
          path: '/provision',
        },
        // The list header action that opens it. The component itself renders
        // nothing for non-admins: a client's owner sees the list to *read* their
        // site, and creating sites is the agency's job.
        list: {
          actions: ['@/provisioning/NewSiteButton'],
        },
      },
    },
  },
  labels: {
    singular: 'سایت',
    plural: 'سایت‌ها',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      label: 'نام',
      required: true,
    },
    {
      name: 'domain',
      type: 'text',
      label: 'دامنه',
      required: true,
      unique: true,
      index: true,
      admin: {
        description: 'میزبان کامل بدون پروتکل — مثلاً acme.ir. DNS: یک رکورد A به IP سرور یا CNAME به نام میزبان سرور بسازید؛ سپس دامنه را تأیید کنید.',
      },
      // Host matching is an exact string compare, so a protocol, port or path
      // here would simply never match and the site would 404 with no clue why.
      validate: (value: string | null | undefined) =>
        !value || /^[a-z0-9.-]+$/.test(value)
          ? true
          : 'دامنه باید فقط میزبان باشد: بدون //:http، بدون پورت و بدون مسیر.',
    },
    {
      name: 'domainVerified',
      type: 'checkbox',
      label: 'دامنه تأیید شده',
      defaultValue: false,
      admin: {
        description: 'فقط پس از اطمینان از وجود رکورد DNS و اشارهٔ آن به این سرور فعال کنید. دامنهٔ تأییدنشده گواهی TLS نمی‌گیرد.',
      },
      access: {
        update: platformAdminFieldAccess,
      },
    },
    {
      name: 'type',
      type: 'select',
      label: 'نوع',
      defaultValue: 'business',
      required: true,
      options: [
        { label: 'کسب‌وکار', value: 'business' },
        { label: 'نمونه‌کار', value: 'portfolio' },
        { label: 'فروشگاه', value: 'store' },
      ],
    },
    {
      name: 'status',
      type: 'select',
      label: 'وضعیت',
      defaultValue: 'active',
      required: true,
      index: true,
      options: [
        { label: 'فعال', value: 'active' },
        { label: 'معلق', value: 'suspended' },
        { label: 'بایگانی‌شده', value: 'archived' },
      ],
      admin: {
        description: 'چرخهٔ عمر سایت از این فیلد می‌آید، نه از حذف کردن آن.',
      },
    },
    {
      // Not `locales`: that would create a `sites_locales` table, which is the
      // name Payload reserves for a collection's localized-field table, and the
      // clash breaks every query against this collection.
      name: 'availableLocales',
      type: 'select',
      label: 'زبان‌ها',
      hasMany: true,
      defaultValue: ['fa'],
      required: true,
      options: localeOptions,
      admin: {
        description: 'زیرمجموعه‌ای از زبان‌های پلتفرم که این سایت ارائه می‌دهد.',
      },
    },
    {
      name: 'defaultLocale',
      type: 'select',
      label: 'زبان پیش‌فرض',
      defaultValue: 'fa',
      required: true,
      options: localeOptions,
      // A default outside the site's own subset makes every locale-less request
      // resolve to a locale the site does not serve.
      validate: (
        value: string | null | undefined,
        { data }: { data: { availableLocales?: string[] | null } },
      ) =>
        !value || !data?.availableLocales?.length || data.availableLocales.includes(value)
          ? true
          : 'زبان پیش‌فرض باید بین زبان‌های انتخاب‌شدهٔ سایت باشد.',
    },
    // Not localized: a site's slug is an internal identifier, not a public URL.
    slugField({ localized: false, slugify: slugifyField, useAsSlug: 'name' }),
  ],
}
