import { createHash } from 'node:crypto'

import type { Endpoint } from 'payload'

import { blockSlugsForSiteType } from '@/blocks'
import { requestApiKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'
import { siteFromRequest } from '@/lib/site-query'
import { siteOrigin } from '@/lib/site-url'
import { listEnabledGateways } from '@/payments/gateways'
import { contractVersion } from '@eshobe/site-runtime'
import { parseThemeManifest, validateRuntimeSettings } from '@/lib/deploy/manifest'

/**
 * `GET /api/site` — what a renderer needs before it can render anything.
 *
 * The platform's routing contract is "the `Host` header *is* the tenant lookup"
 * (`src/proxy.ts` rewrites on it, `findForSite` scopes by it). An app that is not this
 * app — a site builder, a mobile client, a static export — has the same `Host` but
 * none of the machinery, so it needs one call that answers: which site am I on, which
 * locales does it serve, what are its design tokens, what currency does it price in,
 * and which block types can appear in a page's layout.
 *
 * Without it a second renderer hard-codes `/en`, `fa`-only assumptions, a theme it
 * invents, and a block list it maintains by hand — four ways for the CMS and the
 * frontend to disagree silently. The block list here is the same table the admin's
 * picker uses (`src/blocks/index.ts`), so "the API saved a block the renderer doesn't
 * know" becomes visible instead of blank.
 *
 * ## What it is not
 *
 * Not a content endpoint — pages still come from `/api/pages`, now host-scoped at the
 * access layer (`src/access/siteRead.ts`). And not a site *listing*: there is exactly
 * one answer per `Host`, and an unknown host gets 404 rather than a list of customers.
 */
export const siteDescriptor: Endpoint = {
  path: '/site',
  method: 'get',
  handler: async (req) => {
    let site = await siteFromRequest(req)
    let resolvedByApiKey = false

    // WAVE-9 §9.4 — a headless client calling from its own server (not a
    // customer domain) has no `Host` to name the tenant with; its site API key
    // does instead. Host is tried first because it is what every real visitor
    // and same-origin renderer sends, and a key is only ever a fallback for the
    // one case `Host` cannot cover.
    if (!site) {
      const key = await requestApiKey(req)
      if (key?.role === 'site' && key.siteId) {
        site = await req.payload.findByID({
          id: key.siteId,
          collection: 'sites',
          depth: 0,
          disableErrors: true,
          // Same exception as the `overrideAccess: true` below: the key itself
          // established the tenant, so this lookup cannot be tenant-scoped by
          // the thing it is establishing.
          overrideAccess: true,
          req,
        })
        resolvedByApiKey = true
      }
    }

    if (!site) {
      return Response.json(
        { error: 'unknown-host' },
        { headers: { 'cache-control': 'no-store' }, status: 404 },
      )
    }

    const siteId = idOf(site.id)

    // `idOf` returns `null | string` because it takes `unknown`; a persisted site always
    // has an id, and `listEnabledGateways` below is typed for one. Answering 404 rather
    // than querying with `null` keeps "a site with no id" from becoming "every site's
    // payment gateways".
    if (!siteId) {
      return Response.json(
        { error: 'unknown-host' },
        { headers: { 'cache-control': 'no-store' }, status: 404 },
      )
    }

    // `overrideAccess: true` because the tenant is already established by this
    // lookup — the same exception `getSiteByHost` documents. Nothing is selected that
    // a public page render could not see; `paymentInstructions` in particular is
    // excluded by the `select` below *and* by its own field access.
    const [store, theme, branding, themeSettings] = await Promise.all([
      req.payload
        .find({
          collection: 'store',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          select: { currency: true, paymentProvider: true, updatedAt: true },
          where: { site: { equals: siteId } },
        })
        .then(({ docs }) => docs[0] as (typeof docs)[0] & { updatedAt?: string }),
      req.payload
        .find({
          collection: 'theme',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          select: {
            accent: true,
            background: true,
            foreground: true,
            lineHeight: true,
            primary: true,
            radius: true,
            updatedAt: true,
          },
          where: { site: { equals: siteId } },
        })
        .then(({ docs }) => docs[0] as (typeof docs)[0] & { updatedAt?: string }),
      req.payload
        .find({
          collection: 'site-branding',
          depth: 1,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          where: { site: { equals: siteId } },
        })
        .then(({ docs }) => docs[0] as unknown as Record<string, unknown> | undefined),
      req.payload
        .find({
          collection: 'site-theme-settings',
          depth: 1,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          select: {
            contentBindings: true,
            runtimeSettings: true,
            themePackage: true,
            updatedAt: true,
          },
          where: { site: { equals: siteId } },
        })
        .then(({ docs }) => docs[0] as unknown as Record<string, unknown> | undefined),
    ])

    const publicMedia = (value: unknown) => {
      if (!value || typeof value !== 'object') return null
      const media = value as Record<string, unknown>
      return {
        alt: typeof media.alt === 'string' ? media.alt : null,
        id: String(media.id ?? ''),
        updatedAt: typeof media.updatedAt === 'string' ? media.updatedAt : null,
        url: typeof media.url === 'string' ? media.url : null,
      }
    }
    const packageDoc =
      themeSettings?.themePackage && typeof themeSettings.themePackage === 'object'
        ? (themeSettings.themePackage as Record<string, unknown>)
        : null
    const parsedManifest = packageDoc?.manifest
      ? parseThemeManifest(packageDoc.manifest, contractVersion)
      : null
    const manifest = parsedManifest?.ok ? parsedManifest.manifest : null
    const submittedRuntime =
      themeSettings?.runtimeSettings &&
      typeof themeSettings.runtimeSettings === 'object' &&
      !Array.isArray(themeSettings.runtimeSettings)
        ? (themeSettings.runtimeSettings as Record<string, unknown>)
        : {}
    const runtimeSettings = manifest
      ? validateRuntimeSettings(manifest, submittedRuntime).values
      : {}
    const contentBindings =
      themeSettings?.contentBindings &&
      typeof themeSettings.contentBindings === 'object' &&
      !Array.isArray(themeSettings.contentBindings)
        ? themeSettings.contentBindings
        : {}
    const resolvedBindings = Object.fromEntries(
      await Promise.all(
        Object.entries(contentBindings as Record<string, unknown>).map(async ([key, raw]) => {
          const binding = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
          const type = String(binding.type ?? '')
          const id = String(binding.id ?? '')
          const collection = (
            {
              category: 'categories',
              form: 'forms',
              media: 'media',
              page: 'pages',
              post: 'posts',
            } as const
          )[type as 'category']
          if (!collection || !id) return [key, null]
          const target = (await req.payload.findByID({
            collection: collection as 'pages',
            depth: 0,
            disableErrors: true,
            id,
            overrideAccess: true,
            req,
            select: { filename: true, site: true, slug: true, title: true, updatedAt: true },
          })) as unknown as null | Record<string, unknown>
          if (!target || idOf(target.site) !== siteId) return [key, null]
          return [
            key,
            {
              id,
              type,
              slug: typeof target.slug === 'string' ? target.slug : null,
              title: typeof target.title === 'string' ? target.title : null,
              filename: typeof target.filename === 'string' ? target.filename : null,
              updatedAt: typeof target.updatedAt === 'string' ? target.updatedAt : null,
            },
          ]
        }),
      ),
    )
    const bindingTimestamps = Object.values(resolvedBindings).flatMap((binding) => {
      const updatedAt =
        binding && typeof binding === 'object'
          ? (binding as { updatedAt?: unknown }).updatedAt
          : null
      return typeof updatedAt === 'string' ? [updatedAt] : []
    })

    const storeSettings = store
      ? { currency: store.currency, paymentProvider: store.paymentProvider }
      : // A store site whose editor has not saved the settings doc yet: the same
        // defaults `src/lib/store.ts` falls back to, so the renderer never invents
        // a currency and a storefront never renders "480,000" with no unit.
        { currency: 'IRT' as const, paymentProvider: 'bank' as const }

    /**
     * Which Iranian PSPs this site will take, in the order the buyer should see them.
     *
     * Here as well as on `GET /api/payments/methods` because a headless renderer already
     * makes this one call before it can render anything at all, and a storefront that had
     * to make a second round trip to draw the payment picker would draw it late — after
     * the buy button, which is exactly when a buyer notices. `methods` costs one query and
     * carries no row ids and no credentials (`EnabledGateway` has no field for either), so
     * it is as public as the rest of this body.
     *
     * No `amount` filter: the descriptor is site-wide and cached, and the checkout
     * endpoint re-checks each gateway's window against the actual basket. A renderer that
     * knows the quantity asks `/api/payments/methods?amount=` instead.
     */
    const methods = await listEnabledGateways({
      currency: storeSettings.currency,
      locale: site.defaultLocale ?? undefined,
      req,
      siteId,
    })

    const body = {
      // Both locales and the default: a renderer must 404 `/de` on a `fa`+`en` site
      // rather than falling back and duplicating the home page under a URL that
      // does not exist (`src/app/(site)/[domain]/[[...path]]/page.tsx` does exactly
      // this, and it needs the same data to do it).
      availableLocales: site.availableLocales ?? [],
      blocks: blockSlugsForSiteType(site.type),
      contractVersion,
      defaultLocale: site.defaultLocale,
      domain: site.domain,
      // Internal fields — a database id and an admin-only verification flag — are
      // only handed back when a site key proved the caller *is* that site's own
      // builder. The public, `Host`-resolved response (any visitor on the domain)
      // never carries them: `tests/int/headless.int.spec.ts` pins that.
      ...(resolvedByApiKey ? { domainVerified: Boolean(site.domainVerified), id: siteId } : {}),
      // Where uploads resolve. Local storage serves them relative
      // (`/api/media/file/x.png`), which is meaningless off-domain: a consumer
      // builds `new URL(media.url, media.origin)`. Media is served through the CMS
      // proxy (`/api/media/file/*`), not from the bucket URL, so the bucket stays
      // private.
      media: { basePath: '/api/media/file', origin: siteOrigin(site, req.origin) },
      branding: branding
        ? {
            displayName: branding.displayName,
            shortName: branding.shortName ?? null,
            tagline: branding.tagline ?? null,
            primaryLogo: publicMedia(branding.primaryLogo),
            compactLogo: publicMedia(branding.compactLogo),
            lightLogo: publicMedia(branding.lightLogo),
            darkLogo: publicMedia(branding.darkLogo),
            favicon: publicMedia(branding.favicon),
            socialImage: publicMedia(branding.socialImage),
          }
        : {
            displayName: site.name,
            shortName: null,
            tagline: null,
            primaryLogo: null,
            compactLogo: null,
            lightLogo: null,
            darkLogo: null,
            favicon: null,
            socialImage: null,
          },
      name: site.name,
      slug: site.slug,
      status: site.status,
      payments: { currency: storeSettings.currency, methods },
      store: storeSettings,
      theme: theme
        ? {
            accent: theme.accent,
            background: theme.background,
            foreground: theme.foreground,
            lineHeight: theme.lineHeight,
            primary: theme.primary,
            radius: theme.radius,
          }
        : null,
      themeRuntime: manifest
        ? {
            package: { key: packageDoc?.key ?? null },
            settings: runtimeSettings,
            bindings: resolvedBindings,
          }
        : null,
      type: site.type,
    }

    const json = JSON.stringify(body)
    const etag = `"${createHash('sha256').update(json).digest('hex').slice(0, 32)}"`
    const timestamps = [
      site.updatedAt,
      store?.updatedAt,
      theme?.updatedAt,
      branding?.updatedAt,
      themeSettings?.updatedAt,
      ...bindingTimestamps,
    ].filter(Boolean) as string[]
    const latest = timestamps.length
      ? new Date(Math.max(...timestamps.map((t) => Date.parse(t)))).toUTCString()
      : new Date().toUTCString()

    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, {
        headers: {
          'cache-control': resolvedByApiKey
            ? 'private, no-store'
            : 'public, s-maxage=30, stale-while-revalidate=300',
          etag,
          'last-modified': latest,
          vary: 'Host',
        },
        status: 304,
      })
    }

    return Response.json(body, {
      headers: {
        // Cached briefly and publicly, and never on a mismatched host: this
        // response is per-tenant, so a shared cache keyed by path alone would serve
        // one customer's theme to another's domain. An API-key-resolved response
        // (no `Host` to vary on at all) is never cached publicly, for the same
        // reason — a shared cache has no way to key it by bearer token.
        'cache-control': resolvedByApiKey
          ? 'private, no-store'
          : 'public, s-maxage=30, stale-while-revalidate=300',
        etag,
        'last-modified': latest,
        vary: 'Host',
      },
      status: 200,
    })
  },
}
