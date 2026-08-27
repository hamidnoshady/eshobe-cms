import { postgresAdapter } from '@payloadcms/db-postgres'
import { getTenantFromCookie } from '@payloadcms/plugin-multi-tenant/utilities'
import { en } from '@payloadcms/translations/languages/en'
import { fa } from '@payloadcms/translations/languages/fa'
import sharp from 'sharp'
import path from 'path'
import { buildConfig, PayloadRequest } from 'payload'
import { fileURLToPath } from 'url'

import { Categories } from './collections/Categories'
import { Media } from './collections/Media'
import { Pages } from './collections/Pages'
import { Posts } from './collections/Posts'
import { Sites } from './collections/Sites'
import { Theme } from './collections/Theme'
import { Users } from './collections/Users'
import { Footer } from './Footer/config'
import { Header } from './Header/config'
import { defaultLocale, locales } from './lib/locales'
import { migrations } from './migrations'
import { plugins } from './plugins'
import { defaultLexical } from '@/fields/defaultLexical'
import { getServerSideURL } from './utilities/getURL'
import { domainCheck } from './endpoints/domainCheck'
import { provisionSiteEndpoint } from './endpoints/provisionSite'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  endpoints: [domainCheck, provisionSiteEndpoint],
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
  collections: [Pages, Posts, Media, Categories, Users, Sites, Theme, Header, Footer],
  cors: [getServerSideURL()].filter(Boolean),
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
    tasks: [],
  },
})
