import type { Endpoint } from 'payload'

import { blockSlugsForSiteType } from '@/blocks'
import { requestApiKey } from '@/access/siteApiKey'
import { idOf } from '@/lib/ids'
import { siteFromRequest } from '@/lib/site-query'
import { siteOrigin } from '@/lib/site-url'

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
      return Response.json({ error: 'unknown-host' }, { headers: { 'cache-control': 'no-store' }, status: 404 })
    }

    const siteId = idOf(site.id)

    // `overrideAccess: true` because the tenant is already established by this
    // lookup — the same exception `getSiteByHost` documents. Nothing is selected that
    // a public page render could not see; `paymentInstructions` in particular is
    // excluded by the `select` below *and* by its own field access.
    const [store, theme] = await Promise.all([
      req.payload
        .find({
          collection: 'store',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          select: { currency: true, paymentProvider: true },
          where: { site: { equals: siteId } },
        })
        .then(({ docs }) => docs[0]),
      req.payload
        .find({
          collection: 'theme',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          pagination: false,
          req,
          select: { accent: true, background: true, foreground: true, lineHeight: true, primary: true, radius: true },
          where: { site: { equals: siteId } },
        })
        .then(({ docs }) => docs[0]),
    ])

    return Response.json(
      {
        // Both locales and the default: a renderer must 404 `/de` on a `fa`+`en` site
        // rather than falling back and duplicating the home page under a URL that
        // does not exist (`src/app/(site)/[domain]/[[...path]]/page.tsx` does exactly
        // this, and it needs the same data to do it).
        availableLocales: site.availableLocales ?? [],
        blocks: blockSlugsForSiteType(site.type),
        defaultLocale: site.defaultLocale,
        domain: site.domain,
        // Where uploads resolve. Local storage serves them relative
        // (`/api/media/file/x.png`), which is meaningless off-domain: a consumer
        // builds `new URL(media.url, media.origin)`. Moves to the R2 bucket URL when
        // the storage adapter lands (WAVE-9.md §4).
        media: { basePath: '/api/media/file', origin: siteOrigin(site, req.origin) },
        name: site.name,
        slug: site.slug,
        status: site.status,
        store: store
          ? { currency: store.currency, paymentProvider: store.paymentProvider }
          : // A store site whose editor has not saved the settings doc yet: the same
            // defaults `src/lib/store.ts` falls back to, so the renderer never invents
            // a currency and a storefront never renders "480,000" with no unit.
            { currency: 'IRT', paymentProvider: 'bank' },
        theme: theme ?? null,
        type: site.type,
      },
      {
        headers: {
          // Cached briefly and publicly, and never on a mismatched host: this
          // response is per-tenant, so a shared cache keyed by path alone would serve
          // one customer's theme to another's domain. An API-key-resolved response
          // (no `Host` to vary on at all) is never cached publicly, for the same
          // reason — a shared cache has no way to key it by bearer token.
          'cache-control': resolvedByApiKey
            ? 'private, no-store'
            : 'public, s-maxage=30, stale-while-revalidate=300',
          'vary': 'Host',
        },
        status: 200,
      },
    )
  },
}
