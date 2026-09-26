import { postgresAdapter } from '@payloadcms/db-postgres'
import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import { getTenantFromCookie } from '@payloadcms/plugin-multi-tenant/utilities'
import { en } from '@payloadcms/translations/languages/en'
import { fa } from '@payloadcms/translations/languages/fa'
import sharp from 'sharp'
import path from 'path'
import { buildConfig, PayloadRequest } from 'payload'
import { fileURLToPath } from 'url'

import { ApiKeys } from './collections/ApiKeys'
import { AuditLog } from './collections/AuditLog'
import { Categories } from './collections/Categories'
import { CdnEvents } from './collections/CdnEvents'
import { CdnZones } from './collections/CdnZones'
import { DeployTargets } from './collections/DeployTargets'
import { DomainResellerProducts } from './collections/DomainResellerProducts'
import { FeatureFlags } from './collections/FeatureFlags'
import { Invoices } from './collections/Invoices'
import { ResellerDomainEvents } from './collections/ResellerDomainEvents'
import { ResellerDomainOperations } from './collections/ResellerDomainOperations'
import { ResellerDomains } from './collections/ResellerDomains'
import { Media } from './collections/Media'
import { Orders } from './collections/Orders'
import { PaymentGateways } from './collections/PaymentGateways'
import { Plans } from './collections/Plans'
import { Plugins } from './collections/Plugins'
import { Products } from './collections/Products'
import { Pages } from './collections/Pages'
import { Posts } from './collections/Posts'
import { SiteDeployments } from './collections/SiteDeployments'
import { SiteEntitlements } from './collections/SiteEntitlements'
import { SiteThemeSettings } from './collections/SiteThemeSettings'
import { Sites } from './collections/Sites'
import { StorageConnections } from './collections/StorageConnections'
import { Store } from './collections/Store'
import { Subscriptions } from './collections/Subscriptions'
import { Theme } from './collections/Theme'
import { ThemePackages } from './collections/ThemePackages'
import { ThemeTemplates } from './collections/ThemeTemplates'
import { UsageRecords } from './collections/UsageRecords'
import { Users } from './collections/Users'
import { WebhookDeliveries } from './collections/WebhookDeliveries'
import { Webhooks } from './collections/Webhooks'
import { DomainReseller } from './globals/DomainReseller'
import { Payments } from './globals/Payments'
import { PlatformSettings } from './globals/PlatformSettings'
import { Footer } from './Footer/config'
import { Header } from './Header/config'
import { runtimeDatabaseOptions } from './lib/database'
import { assertProductionEnv, jobsAutoRunEnabled } from './lib/env'
import { defaultLocale, locales } from './lib/locales'
import { advanceDeploymentsTask } from './deploy/task'
import { storageHealthCheckTask } from './storage/task'
import { plugins } from './plugins'
import { defaultLexical } from '@/fields/defaultLexical'
import { getServerSideURL } from './utilities/getURL'
import { checkoutEndpoints } from './endpoints/checkout'
import { cdnEndpoints } from './endpoints/cdn'
import { domainCheck } from './endpoints/domainCheck'
import { domainResellerEndpoints } from './endpoints/domainReseller'
import { handoffEndpoint, handoffPostEndpoint } from './endpoints/handoff'
import { provisionSiteEndpoint } from './endpoints/provisionSite'
import { paymentGatewayEndpoints } from './endpoints/paymentGateways'
import { platformControlEndpoints } from './endpoints/platformControl'
import { platformDeploymentEndpoints } from './endpoints/platformDeployments'
import { platformSaasEndpoints } from './endpoints/platformSaas'
import { siteDescriptor } from './endpoints/siteDescriptor'
import { updateSiteDomain } from './endpoints/updateSiteDomain'
import { siteDomainsEndpoints } from './endpoints/siteDomains'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const emailFromAddress =
  process.env.EMAIL_FROM ?? `noreply@${process.env.CONTROL_PLANE_HOST ?? 'example.com'}`
const emailConfig = process.env.SMTP_HOST
  ? {
      defaultFromAddress: emailFromAddress,
      defaultFromName: 'Eshobe CMS',
      transportOptions: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth:
          process.env.SMTP_USER && process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
      },
    }
  : {
      defaultFromAddress: emailFromAddress,
      defaultFromName: 'Eshobe CMS',
      // No SMTP configured — emit JSON to the logger instead of attempting network.
      // Payload's default adapter does the same, but this is explicit and
      // skipVerify avoids a startup check against a missing server.
      transportOptions: { jsonTransport: true } as Record<string, unknown>,
      skipVerify: true,
    }

export default buildConfig({
  email: nodemailerAdapter(emailConfig as Parameters<typeof nodemailerAdapter>[0]),
  endpoints: [
    domainCheck,
    siteDescriptor,
    updateSiteDomain,
    ...siteDomainsEndpoints,
    ...domainResellerEndpoints,
    provisionSiteEndpoint,
    handoffEndpoint,
    handoffPostEndpoint,
    ...checkoutEndpoints,
    // The api-keys lifecycle trio (`/issue`, `/list`, `/revoke`) and
    // `/storage-connections/self-test` are **not** here — they are collection
    // endpoints, on `ApiKeys` and `StorageConnections` respectively. Payload
    // dispatches `/api/<first-segment>/…` against that collection's own endpoints
    // whenever the first segment is a collection slug, and never falls back to this
    // list: a top-level endpoint whose path starts with a collection slug is
    // unreachable by construction (404 "Route not found"). Both of these lived here
    // once and answered 404 to every caller, including the POS console.
    ...paymentGatewayEndpoints,
    ...cdnEndpoints,
    // The operator surface: one credential and a base URL, and the sibling POS's
    // super-admin console administers and reports on this whole deployment
    // («سایت‌ساز» — docs/eshobe-cms-integration.md §7). Platform-admin session or a
    // `role: "platform"` key only, and deliberately left behind
    // `@control_plane_paths` in the Caddyfile: it is staff-only, so it must not be
    // routable from a customer domain.
    //
    // The SaaS half is spread **before** it, and the order is load-bearing: Payload
    // matches endpoints in array order, and `platformControlEndpoints` contains a
    // bare `/platform/sites/:id`, which would otherwise swallow
    // `/platform/sites/:id/quota`, `/entitlement`, `/usage`, `/features` and
    // `/theme` with `id` set to the site and the rest ignored — a 200 with the wrong
    // body, which is the failure mode that does not look like one. The same trap the
    // fleet file records for its own `/snapshot` pair.
    ...platformSaasEndpoints,
    // Wave 11 — the deployable-theme surface, spread here for the same ordering
    // reason as the SaaS routes above it: it registers several literal
    // `/platform/sites/:id/deployment*` paths that the fleet file's bare
    // `/platform/sites/:id` would otherwise swallow, answering 200 with the wrong
    // body. `/api/deploy-targets/self-test` is **not** here — it is a collection
    // endpoint on `DeployTargets`, because a path whose first segment is a
    // collection slug never reaches this array.
    ...platformDeploymentEndpoints,
    ...platformControlEndpoints,
  ],
  globals: [
    DomainReseller,
    /**
     * The only Payload global in this codebase. Everything else that looks like a
     * singleton (`store`, `theme`, `header`, `footer`) is a collection registered
     * `isGlobal: true` in the multi-tenant plugin's map, because a Payload global cannot
     * be tenant-scoped — and this one deliberately is not: "is the payment module on at
     * all" is the platform operator's question, not a site's.
     */
    Payments,
    /**
     * The operator's own policy document — the second and last global here, by the
     * same test `Payments` states: one answer for the whole deployment *is* the
     * point. Quota policy, signup policy, retention and the maintenance flag are the
     * platform's questions, not any customer's. Anything that ever needs a
     * per-customer exception moves to `site-entitlements` instead.
     */
    PlatformSettings,
  ],
  admin: {
    components: {
      /**
       * The operator's console. Payload's stock dashboard is a grid of collection
       * counts, which for a platform admin sums across every customer and answers
       * a question nobody asked — this puts the fleet, billing and infrastructure
       * report above it, and renders nothing at all for a customer's staff.
       */
      // Two front pages, one slot: `OperatorDashboard` renders for platform staff
      // and nothing for a customer; `CustomerDashboard` does the reverse. Neither
      // is an access boundary — both re-check the role and run tenant-scoped.
      beforeDashboard: ['@/admin/OperatorDashboard', '@/admin/CustomerDashboard'],
      beforeLogin: ['@/components/BeforeLogin'],
      /**
       * The audience-aware sidebar. Payload's stock nav groups by each entity's
       * static `admin.group`, which cannot give a shared collection (`sites`,
       * `users`) one label for a customer and another for an operator, nor model
       * product-oriented grouping (Forms = `forms` + `form-submissions`). The
       * information architecture lives in `src/admin/navigation.ts`; `admin.hidden`
       * still decides visibility. See `src/admin/nav/EshobeNav.tsx`.
       */
      Nav: '@/admin/nav/EshobeNav',
    },
    importMap: {
      baseDir: path.resolve(dirname),
    },
    user: Users.slug,
    livePreview: {
      breakpoints: [
        {
          label: 'Mobile',
          name: 'mobile',
          width: 375,
          height: 667,
        },
        {
          label: 'Tablet',
          name: 'tablet',
          width: 768,
          height: 1024,
        },
        {
          label: 'Desktop',
          name: 'desktop',
          width: 1440,
          height: 900,
        },
      ],
    },
  },
  // This config helps us configure global or default features that the other editors can inherit
  editor: defaultLexical,
  // Runtime uses DATABASE_URL only. No boot-time migrations: the one-shot
  // `pnpm migrate` entrypoint uses MIGRATE_DATABASE_URL before web starts.
  // Development keeps Payload's existing push mode unchanged.
  db: postgresAdapter(runtimeDatabaseOptions()),
  collections: [
    Pages,
    Posts,
    Media,
    Categories,
    Users,
    Sites,
    // WAVE-9 §9.4 — platform-admin only, deliberately not in the multi-tenant
    // plugin's `collections` map (src/plugins/index.ts): a key is credential
    // material, the same shape as `Users`, not a site's own content.
    ApiKeys,
    // Object storage — platform-admin only and platform-wide, not in the multi-tenant
    // plugin's map for the same reason as `ApiKeys`: it holds the ArvanCloud bucket
    // credentials every site's media writes through, so it is shared infrastructure,
    // not a site's own content.
    StorageConnections,
    Theme,
    Header,
    Footer,
    // Wave 7 — the store. `products` and `orders` are ordinary tenant-scoped
    // collections; `store` is a per-site singleton. All three are in the multi-tenant
    // plugin's `collections` map (src/plugins/index.ts) — see the rule in CLAUDE.md.
    Products,
    Orders,
    Store,
    // Wave 10 — one row per (site, gateway), holding the AES-encrypted credentials a
    // platform admin typed and the tenant's own on/off switch. In the multi-tenant
    // plugin's `collections` map for the reason CLAUDE.md states: unregistered means
    // shared by every tenant, and here that would mean one customer's merchant
    // credentials editable from another customer's admin.
    PaymentGateways,
    CdnZones,
    CdnEvents,
    DomainResellerProducts,
    ResellerDomains,
    ResellerDomainOperations,
    ResellerDomainEvents,
    /**
     * The SaaS control plane.
     *
     * Every one of these is `platformAdmin` on all four access operations and
     * `hidden` from a customer's nav — they are how the operator runs the business,
     * not how a customer runs their website. The split in the admin is
     * `src/admin/visibility.ts`: a platform admin sees these and not the content
     * collections, a customer's staff see the content collections and not these.
     *
     * Registration with the multi-tenant plugin is decided per collection in
     * `src/plugins/index.ts`, with the reasoning there — the short version is that
     * the four carrying exactly one site are registered, and the catalogue ones are
     * not.
     */
    Plans,
    Subscriptions,
    Invoices,
    SiteEntitlements,
    UsageRecords,
    FeatureFlags,
    Plugins,
    ThemeTemplates,
    /**
     * Wave 11 — deployable themes.
     *
     * `theme-packages` (a GitHub repo built against docs/THEME_API.md) and
     * `deploy-targets` (a Coolify connection) are the operator's catalogue and
     * infrastructure, so they take the documented multi-tenant exception alongside
     * `theme-templates`. `site-deployments` and `site-theme-settings` each carry
     * exactly one site and are registered with the plugin — see `src/plugins/index.ts`.
     *
     * `theme-packages` is deliberately separate from `theme-templates`: one is a
     * program with a build and a port, the other is a set of hex tokens. Merging
     * them would mean editing a colour catalogue could redeploy production.
     */
    ThemePackages,
    DeployTargets,
    SiteDeployments,
    SiteThemeSettings,
    Webhooks,
    WebhookDeliveries,
    AuditLog,
  ],
  /**
   * Origins allowed to call the API with credentials. The deployment origin is the
   * admin; `API_CORS_ORIGINS` is for *separate* frontends attaching to this CMS (a
   * site builder on its own host), because Payload's cookie auth will not cross an
   * origin without an explicit allowance.
   *
   * A list rather than `true`: `cors: true` reflects any origin with credentials,
   * which on a platform holding every customer's content is a CSRF-shaped hole
   * wearing a convenience.
   */
  cors: [
    getServerSideURL(),
    ...(process.env.API_CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ].filter(Boolean),
  // Persian first: `fa` is the fallback for both content and admin chrome.
  localization: {
    defaultLocale,
    fallback: true,
    locales,
    /**
     * The locale switcher lists every platform locale by default, including ones
     * the selected site does not serve — editors would translate into a locale
     * that never renders.
     *
     * Resolved once per admin load, so it goes stale when the tenant selector
     * changes; `RefreshOnTenantChange` forces a refresh.
     */
    filterAvailableLocales: async ({ locales: availableLocales, req }) => {
      // 'text' because `idType: 'uuid'` — the cookie value is not a number.
      const siteId = getTenantFromCookie(req.headers, 'text')

      if (!siteId) return availableLocales

      const site = await req.payload.findByID({
        id: String(siteId),
        collection: 'sites',
        depth: 0,
        disableErrors: true,
        req,
      })

      // No site (deleted, or not this user's) → leave the list alone rather than
      // blanking the switcher.
      const served: string[] = site?.availableLocales ?? []
      if (!served.length) return availableLocales

      return availableLocales.filter(({ code }) => served.includes(code))
    },
  },
  i18n: {
    fallbackLanguage: 'fa',
    // Every extra language ships another dictionary into the admin bundle.
    supportedLanguages: { en, fa },
    /**
     * `plugin-redirects` ships en/es/fr/ja/pt/sv and no fa, so its field labels
     * rendered as raw keys (`plugin-redirects:fromUrl`) in the Persian admin. It
     * merges its own dictionary *into* this one, and only for the languages it has —
     * so adding fa here is enough, and overriding each field's `label` is not.
     */
    translations: {
      fa: {
        'plugin-redirects': {
          customUrl: 'نشانی دلخواه',
          documentToRedirect: 'برگه یا نوشته مقصد',
          fromUrl: 'از نشانی',
          internalLink: 'پیوند داخلی',
          redirectType: 'نوع تغییر مسیر',
          toUrlType: 'نوع مقصد',
        },
      },
    },
  },
  plugins,
  /**
   * The GraphQL API stays on — `WAVE-9.md` names REST *and* GraphQL as the
   * surface a second renderer attaches to, so disabling it would retract a
   * documented contract — but it stops being unbounded in shape.
   *
   * Access control already decides *which rows* a caller sees: GraphQL runs the
   * same `src/access/siteRead.ts` scoping as REST, so it cannot read across
   * tenants (an anonymous query on the control-plane host answers 403). What it
   * could do was ask for one tenant's rows in an arbitrarily expensive shape.
   * The schema is deeply self-referential — a page holds a `layout` of blocks,
   * blocks hold media and link fields pointing back at pages and posts — so a
   * query can nest through those relationships until the resolver count
   * explodes, from one unweighted request.
   *
   * 300 is chosen from measurement, not taste. Payload scores a query with
   * `simpleEstimator({ defaultComplexity: 1 })`, so the number is essentially
   * "fields resolved across the query tree". Against this schema:
   *
   *     a page list with meta and images                    22
   *     one page with all 14 block types expanded           43
   *     pages + posts + products + theme + store at once    84
   *     five levels of relatedPosts → categories            66
   *
   * So real renderer traffic lives under ~100, and 300 leaves a richer consumer
   * room to grow while still cutting off runaway nesting. A legitimate query
   * that ever hits the ceiling should have this number raised deliberately,
   * with the query that needed it named in the commit — the failure is loud and
   * reports the actual complexity, so there is no guessing.
   *
   * **What this does not bound is volume.** Complexity counts fields, never
   * rows, so `Pages(limit: 100000)` scores the same as `Pages(limit: 10)` and
   * costs the database far more. Payload 3.88 has no `maxLimit` — only
   * `pagination.defaultLimit`, which a caller overrides — so clamping that needs
   * a hook and would have to cover REST too. It is a separate piece of work and
   * is not fixed here.
   *
   * The two `disable*InProduction` flags are already Payload's defaults. They
   * are written out because they are load-bearing and silent: nothing fails if a
   * future version flips a default, the schema simply becomes readable.
   */
  graphQL: {
    disableIntrospectionInProduction: true,
    disablePlaygroundInProduction: true,
    maxComplexity: 300,
  },
  secret: process.env.PAYLOAD_SECRET,
  sharp,
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  /**
   * Runs the queue inside this container, once a minute.
   *
   * Scheduled publishing (`versions.drafts.schedulePublish` on pages and posts) is
   * the only producer today: the admin queues a `schedulePublish` job with a
   * `waitUntil`, and nothing publishes it unless something runs the queue. On this
   * deployment that something is the web container itself — a VPS process that
   * outlives a request, which is what makes `autoRun` usable at all.
   *
   * Two constraints ride on that, both of which fail silently rather than loudly:
   * `autoRun` must never be used on serverless, and every extra web replica runs the
   * same cron against the same queue. `jobsAutoRunEnabled` keeps the switch in one
   * place; the upgrade path is a separate `payload jobs:run` container.
   */
  jobs: {
    access: {
      run: ({ req }: { req: PayloadRequest }): boolean => {
        // Allow logged in users to execute this endpoint (default)
        if (req.user) return true

        const secret = process.env.CRON_SECRET
        if (!secret) return false

        // If there is no logged in user, then check
        // for the Vercel Cron secret to be present as an
        // Authorization header:
        const authHeader = req.headers.get('authorization')
        return authHeader === `Bearer ${secret}`
      },
    },
    // Empty, not merely gated by `shouldAutoRun`: an entry here schedules a cron on
    // every boot, and a cron that immediately decides to do nothing is still a timer
    // in every dev server and every test process.
    autoRun: jobsAutoRunEnabled()
      ? [
          {
            cron: '* * * * *',
            // The queue the admin's schedule drawer posts to. It does not name one,
            // and Payload's default is 'default'.
            queue: 'default',
            limit: 10,
          },
        ]
      : [],
    // Belt and braces: `autoRun` is resolved once at startup, this is consulted on
    // every tick, so flipping the env var and restarting is always enough.
    shouldAutoRun: () => jobsAutoRunEnabled(),
    /**
     * Wave 11's deployment poller is the first real entry here. It is a *task* with
     * its own `schedule`, not a second `autoRun` cron: an entry above schedules a
     * timer on every boot, and the queue this drains is already the one being
     * drained. The same single-replica caveat applies unchanged — two web replicas
     * poll the same deployments twice, which is wasteful rather than wrong (the
     * status machine in `src/lib/deploy/status.ts` refuses illegal repeats), but it
     * is still the reason `JOBS_AUTORUN=false` plus a `payload jobs:run` container
     * is the upgrade path.
     */
    tasks: [advanceDeploymentsTask, storageHealthCheckTask],
  },
  /**
   * Last line of defence for the values that only bite in production. Deliberately
   * in `onInit`: it runs on a real app boot, never during `next build` (which
   * uses placeholder secrets) or the one-shot migrator (disableOnInit: true).
   */
  onInit: () => {
    assertProductionEnv()
  },
})
