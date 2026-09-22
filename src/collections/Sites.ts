import type { CollectionConfig, Where } from 'payload'

import { slugField } from 'payload'

import { authenticated } from '../access/authenticated'
import { isPlatformAdmin, platformAdmin, platformAdminFieldAccess } from '../access/platformAdmin'
import { platformApiKeyAware } from '../access/siteApiKey'
import {
  domainValidationMessage,
  isValidDomain,
  normalizeDomain,
  siteHostnames,
} from '../lib/domains'
import { locales } from '../lib/locales'
import { slugifyField } from '../lib/slug'
import { PLATFORM_GROUPS } from '@/admin/visibility'

/** Same list the platform offers, in select-field shape. */
const localeOptions = locales.map(({ code, label }) => ({ label, value: code }))

type DomainRow = { hostname?: unknown; id?: unknown; verified?: unknown }
type SiteData = { domain?: unknown; domainVerified?: unknown; domains?: DomainRow[] | null }

/**
 * Normalize hostnames at the write boundary and reject a primary/alias collision
 * before Postgres' unique index needs to provide a terse error. The database
 * migration also guards cross-tenant collisions; this is the helpful CMS-side
 * half of the invariant.
 */
const normalizeAndValidateDomains: NonNullable<CollectionConfig['hooks']>['beforeValidate'] = [
  async ({ data, originalDoc, req }) => {
    const input = (data ?? {}) as SiteData
    const persisted = (originalDoc ?? {}) as SiteData
    const domain =
      typeof input.domain === 'string' ? normalizeDomain(input.domain) : persisted.domain
    const originalAliases = Array.isArray(persisted.domains) ? persisted.domains : []
    const aliases = Array.isArray(input.domains) ? input.domains : originalAliases

    // An unrelated site edit should not rewrite an old document's aliases, but every
    // new primary/alias value is normalized to the one spelling used by Host lookups.
    const normalizedAliases = aliases.map((alias) =>
      typeof alias?.hostname === 'string'
        ? { ...alias, hostname: normalizeDomain(alias.hostname) }
        : alias,
    )

    const primary = typeof domain === 'string' ? domain : ''
    const aliasHosts = normalizedAliases
      .map((alias) => (typeof alias?.hostname === 'string' ? alias.hostname : ''))
      .filter(Boolean)
    const hosts = [primary, ...aliasHosts].filter(Boolean)

    if (primary && !isValidDomain(primary)) {
      throw new Error(domainValidationMessage)
    }

    if (aliasHosts.some((hostname) => !isValidDomain(hostname))) {
      throw new Error(domainValidationMessage)
    }

    const duplicate = hosts.find((hostname, index) => hosts.indexOf(hostname) !== index)
    if (duplicate) {
      throw new Error(`هر میزبان فقط یک‌بار می‌تواند ثبت شود: ${duplicate}`)
    }

    // The regular `sites.domain` column and the alias array live in different
    // PostgreSQL tables, so no ordinary unique index can span both. Ask the CMS for
    // possible matches to turn the collision into a field-level message; the paired
    // migration has database triggers as the race-safe final backstop.
    if (hosts.length && req?.payload) {
      const { docs } = await req.payload.find({
        collection: 'sites',
        depth: 0,
        limit: hosts.length * 2 + 10,
        overrideAccess: true,
        pagination: false,
        req,
        where: {
          or: hosts.flatMap((hostname) => [
            { domain: { equals: hostname } },
            { 'domains.hostname': { equals: hostname } },
          ]) as unknown as Where[],
        },
      })

      const ownId = String((originalDoc as { id?: unknown } | undefined)?.id ?? '')
      const incoming = new Set(hosts)
      const conflict = docs.find((site) => {
        if (String(site.id) === ownId) return false

        return siteHostnames(site).some((hostname) => incoming.has(hostname))
      })

      if (conflict) {
        const duplicateHost = siteHostnames(conflict).find((hostname) => incoming.has(hostname))
        throw new Error(`میزبان «${duplicateHost}» قبلاً به سایت دیگری اختصاص داده شده است.`)
      }
    }

    return {
      ...input,
      ...(typeof input.domain === 'string' ? { domain: primary } : {}),
      ...(Array.isArray(input.domains) ? { domains: normalizedAliases } : {}),
    }
  },
]

/**
 * A changed hostname can never inherit the old hostname's TLS approval. This is
 * particularly important for edits made in the regular CMS form, which do not go
 * through the site-key endpoint.
 */
const resetVerificationOnHostChange: NonNullable<CollectionConfig['hooks']>['beforeChange'] = [
  ({ data, originalDoc }) => {
    const input = (data ?? {}) as SiteData
    const persisted = (originalDoc ?? {}) as SiteData
    const next: SiteData = { ...input }

    if (
      typeof input.domain === 'string' &&
      typeof persisted.domain === 'string' &&
      normalizeDomain(input.domain) !== normalizeDomain(persisted.domain)
    ) {
      next.domainVerified = false
    }

    if (Array.isArray(input.domains)) {
      const oldById = new Map(
        (Array.isArray(persisted.domains) ? persisted.domains : [])
          .filter((alias) => alias?.id)
          .map((alias) => [String(alias.id), alias]),
      )

      next.domains = input.domains.map((alias) => {
        const previous = alias?.id ? oldById.get(String(alias.id)) : undefined
        const hostname = typeof alias?.hostname === 'string' ? normalizeDomain(alias.hostname) : ''
        const oldHostname =
          typeof previous?.hostname === 'string' ? normalizeDomain(previous.hostname) : ''

        return previous && hostname && oldHostname !== hostname
          ? { ...alias, verified: false }
          : alias
      })
    }

    return next
  },
]

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
    // A platform API key (WAVE-9 §9.4) may also list every site — it is the
    // provisioning console's own credential — but a site key gets nothing here: a
    // site descriptor is `GET /api/site`, never a `sites` document.
    read: platformApiKeyAware(authenticated),
    update: authenticated,
  },
  admin: {
    defaultColumns: ['name', 'domain', 'domainVerified', 'type', 'status'],
    /**
     * Filed with the fleet, but **not** `hidden` from anybody: a customer's staff see
     * their own site here (the tenant plugin scopes the list), and it is where they
     * check whether their domain has verified. The operator sees all of them, which
     * is the console's front door.
     */
    group: PLATFORM_GROUPS.fleet,
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
        /**
         * The Wave 11 deployment console, as a tab on the site document.
         *
         * A document view rather than a collection view because every question it
         * answers is about *this* site — what is serving it, what may be deployed to
         * it, how to get back. `condition` hides the tab from a customer's staff;
         * the view re-checks, and the endpoints behind it re-check again.
         */
        edit: {
          deployment: {
            Component: '@/deploy/admin/DeploymentView',
            meta: { title: 'استقرار پوسته' },
            path: '/deployment',
            tab: {
              condition: ({ req }) => isPlatformAdmin(req?.user),
              /**
               * `href` is **not** derived from `path` above — `DefaultDocumentTab`
               * reads `tab.href` and nothing else, so omitting it silently produces a
               * tab pointing at the document root. The view then renders correctly at
               * its own URL while the only link to it goes somewhere else, which is
               * indistinguishable from the tab being broken.
               *
               * The function form receives the document's admin URL as `apiURL`'s
               * sibling, but not the id — so it is built from the route config and the
               * id is appended by Payload's own `DocumentTabLink`. Returning the bare
               * suffix keeps that behaviour.
               */
              href: '/deployment',
              label: 'استقرار پوسته',
            },
          },
        },
      },
    },
  },
  hooks: {
    beforeChange: resetVerificationOnHostChange,
    beforeValidate: normalizeAndValidateDomains,
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
      label: 'دامنهٔ اصلی',
      required: true,
      unique: true,
      index: true,
      admin: {
        description:
          'نشانی اصلی و canonical سایت، بدون پروتکل — مثلاً acme.ir یا shop.acme.ir. همهٔ نشانی‌های فرعی به این نشانی تغییر مسیر می‌دهند.',
      },
      validate: (value: string | null | undefined) =>
        !value || isValidDomain(value) ? true : domainValidationMessage,
    },
    {
      name: 'domainVerified',
      type: 'checkbox',
      label: 'دامنهٔ اصلی تأیید شده',
      defaultValue: false,
      admin: {
        description:
          'فقط پس از اطمینان از وجود رکورد DNS و اشارهٔ آن به این سرور فعال کنید. با تغییر دامنه، تأیید خودکار برداشته می‌شود.',
      },
      access: {
        update: platformAdminFieldAccess,
      },
    },
    {
      name: 'domains',
      type: 'array',
      label: 'دامنه‌ها و زیردامنه‌های فرعی',
      labels: { plural: 'دامنه‌های فرعی', singular: 'دامنهٔ فرعی' },
      maxRows: 20,
      admin: {
        description:
          'برای www، زیردامنه‌ها و دامنه‌های قدیمی یک ردیف اضافه کنید. هر نشانی تأییدشده به دامنهٔ اصلی تغییر مسیر دائمی (308) می‌دهد تا SEO و آمار دوپاره نشوند.',
        initCollapsed: true,
      },
      fields: [
        {
          name: 'hostname',
          type: 'text',
          label: 'میزبان',
          required: true,
          unique: true,
          index: true,
          admin: {
            description: 'بدون پروتکل، پورت و مسیر — مثلاً www.acme.ir یا shop.acme.ir.',
          },
          validate: (value: string | null | undefined) =>
            !value || isValidDomain(value) ? true : domainValidationMessage,
        },
        {
          name: 'verified',
          type: 'checkbox',
          label: 'DNS و TLS تأیید شده',
          defaultValue: false,
          admin: {
            description:
              'تا وقتی DNS این نام به سرور اشاره نکرده، آن را تأیید نکنید. نام تأییدنشده نه TLS می‌گیرد و نه به محتوای سایت وصل می‌شود.',
          },
          access: {
            create: platformAdminFieldAccess,
            update: platformAdminFieldAccess,
          },
        },
      ],
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
    /**
     * Who answers for this site's traffic.
     *
     * `platform` — this Next app renders it. Every site starts here and every site
     * can be returned here with one call (`POST /api/platform/sites/:id/deployment/revert`),
     * which is what makes adopting a deployable theme a reversible decision.
     *
     * `deployment` — a theme application does, with Caddy in front of it
     * (`docs/theme-deployments.md` §5). It is read by `/api/domain-check`: a site
     * whose traffic no longer arrives at Caddy must not sit there waiting to issue a
     * certificate nobody will ever request.
     *
     * Written only by the deploy service. Platform-admin even at field level — a
     * customer's owner flipping this would point their own domain at nothing.
     */
    {
      name: 'renderedBy',
      type: 'select',
      label: 'رندر توسط',
      defaultValue: 'platform',
      // Not schema-`required`, unlike `status` beside it: `required` would make every
      // existing `payload.create({ collection: 'sites' })` call site — the seed, the
      // provisioning action, the platform API — a compile error demanding a value
      // whose only correct answer is the default. The default is the invariant here.
      index: true,
      options: [
        { label: 'سکو (رندرر داخلی)', value: 'platform' },
        { label: 'پوستهٔ مستقرشده', value: 'deployment' },
      ],
      access: { update: platformAdminFieldAccess },
      admin: {
        description:
          'با استقرار یک پوستهٔ نصب‌شدنی خودکار تغییر می‌کند. دستی تغییر ندهید؛ «بازگشت به رندرر داخلی» راه درست است.',
        position: 'sidebar',
      },
    },
    {
      name: 'activeDeployment',
      type: 'relationship',
      relationTo: 'site-deployments',
      label: 'استقرار فعال',
      access: { update: platformAdminFieldAccess },
      admin: {
        description: 'ردیف استقراری که هم‌اکنون به این دامنه سرویس می‌دهد.',
        position: 'sidebar',
        readOnly: true,
      },
    },
    // Not localized: a site's slug is an internal identifier, not a public URL.
    slugField({ localized: false, slugify: slugifyField, useAsSlug: 'name' }),
  ],
}
