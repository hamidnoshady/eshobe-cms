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
import { Categories } from './collections/Categories'
import { Media } from './collections/Media'
import { Orders } from './collections/Orders'
import { Products } from './collections/Products'
import { Pages } from './collections/Pages'
import { Posts } from './collections/Posts'
import { Sites } from './collections/Sites'
import { Store } from './collections/Store'
import { Theme } from './collections/Theme'
import { Users } from './collections/Users'
import { Footer } from './Footer/config'
import { Header } from './Header/config'
import { assertProductionEnv, jobsAutoRunEnabled } from './lib/env'
import { defaultLocale, locales } from './lib/locales'
import { migrations } from './migrations'
import { plugins } from './plugins'
import { defaultLexical } from '@/fields/defaultLexical'
import { getServerSideURL } from './utilities/getURL'
import { apiKeysEndpoints } from './endpoints/apiKeys'
import { checkoutEndpoints } from './endpoints/checkout'
import { domainCheck } from './endpoints/domainCheck'
import { handoffEndpoint, handoffPostEndpoint } from './endpoints/handoff'
import { provisionSiteEndpoint } from './endpoints/provisionSite'
import { siteDescriptor } from './endpoints/siteDescriptor'
import { updateSiteDomain } from './endpoints/updateSiteDomain'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const emailFromAddress = process.env.EMAIL_FROM ?? `noreply@${process.env.CONTROL_PLANE_HOST ?? 'example.com'}`
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
    provisionSiteEndpoint,
    handoffEndpoint,
    handoffPostEndpoint,
    ...checkoutEndpoints,
    ...apiKeysEndpoints,
  ],
  admin: {
    components: {
      beforeLogin: ['@/components/BeforeLogin'],
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
  db: postgresAdapter({
    // uuid, not serial: tenants share one database, so IDs must not be enumerable
    idType: 'uuid',
    pool: {
      connectionString: process.env.DATABASE_URL,
    },
    // The production image runs `node server.js` with no Payload CLI, so
    // pending migrations run on init (production only — dev keeps push mode).
    prodMigrations: migrations,
  }),
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
    Theme,
    Header,
    Footer,
    // Wave 7 — the store. `products` and `orders` are ordinary tenant-scoped
    // collections; `store` is a per-site singleton. All three are in the multi-tenant
    // plugin's `collections` map (src/plugins/index.ts) — see the rule in CLAUDE.md.
    Products,
    Orders,
    Store,
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
    tasks: [],
  },
  /**
   * Last line of defence for the values that only bite in production. Deliberately
   * in `onInit`: it runs on a real boot (and on `payload migrate`), never during
   * `next build`, which the Dockerfile deliberately runs with placeholder secrets.
   */
  onInit: () => {
    assertProductionEnv()
  },
})
