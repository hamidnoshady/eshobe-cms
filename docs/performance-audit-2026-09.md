# Performance audit — September 2026

Part A (platform + application performance). This deployment was audited alongside
[`cafe-restaurant-pos`](https://github.com/hamidnoshady/cafe-restaurant-pos); the full report,
with query plans and before/after timings for both, is at
<https://claude.ai/code/artifact/47f97438-dd6f-4ea1-bb78-58ec5872860f>.

Bench: this repo @ `6b85c66`, all 6 migrations applied against PostgreSQL 16.13 with
`pg_stat_statements`, seeded with its own three demo sites (acme / shop / studio), `pnpm dev`.
Query counts per render are production-representative; wall-clock numbers from a dev server
are not, and none are quoted.

## Findings

| | # | Finding | Where |
|---|---|---|---|
| P1 | 14 | Public pages have no cache layer, and invalidate tags nothing registers | `lib/site-query.ts` · `hooks/revalidateSiteGlobal.ts` |
| P1 | 13 | No `encode` in the Caddyfile; media proxied through Node with no `Cache-Control` | `Caddyfile` |
| P1 | 21 | `queryPage` inherits Payload's default `depth: 2` | `app/(site)/[domain]/[[...path]]/queries.ts:36` |
| P2 | 25 | The publish permission probe reads whole documents to get one field | `access/publish.ts:27` |

### 14 — the render path has no cache, and the invalidation lands on nothing

Every render calls `getSiteContext()`, which reads `next/headers` to resolve the tenant from
`Host`. That makes every site route dynamic, so the Next full-route cache never holds a page.
Measured on the acme homepage, warmed:

```
calls | mean_ms | query
    2 |    0.07 | select "pages"."id", "pages_hero_links"."data" …   (hero blocks)
    1 |    0.26 | select "pages"."id","pages"."site_id","pages"."hero_type" …
    1 |    0.08 | select "header"."id","header"."site_id", "header_navItems" …
    1 |    0.07 | select "sites"."id","sites"."name","sites"."domain" …
    1 |    0.07 | select "footer"."id","footer"."site_id", "footer_navItems" …
    1 |    0.06 | select distinct "pages"."id" …                     (relation pre-query)
    1 |    0.03 | select "id","site_id","primary","accent" … from "theme"
```

**9 queries, ~0.8 ms of database time, every one indexed — no N+1.** The schema is in good
shape: the multi-tenant plugin sets `index: true` on the `site` field of every registered
collection (verified in `pg_indexes` across pages, posts, products, media, orders, categories,
redirects, search, form_submissions and payment_gateways), and `pages_slug_idx (slug, _locale)`
plus `sites_domain_idx` cover resolution.

The problem is that database load scales 1:1 with page views for content that changes when an
editor presses publish, and the response says so: `Cache-Control: no-cache, must-revalidate` on
a public marketing homepage.

The part that reads as a bug rather than a decision: `revalidateSiteGlobal.ts` calls
`revalidateTag(siteTag(siteId, collection))` when a header, footer or theme is saved.
`siteTag()` is exported from `site-query.ts` and described there as "shared by readers and
revalidate hooks" — but **no reader registers it**. `findForSite` never passes
`next: { tags }`, and there is no `unstable_cache` anywhere in the repo. The hook invalidates a
cache that does not exist.

Fix — close the loop the tag names already describe:

```ts
// src/lib/site-query.ts
import { unstable_cache } from 'next/cache'

export const findForSiteCached = <T extends CollectionSlug>(
  collection: T, siteId: string, args: FindArgs,
) => unstable_cache(
  () => findForSite(collection, siteId, args),
  ['findForSite', collection, siteId, JSON.stringify(args)],
  { tags: [siteTag(siteId, collection)], revalidate: 300 },
)()
```

Route the anonymous, published reads through it — the chrome first (header, footer, theme,
site), which is three of the nine queries and identical for every visitor to a site.

**Keep draft and preview reads uncached.** They pass a `user`, and caching a per-viewer read is
how a draft leaks across the boundary `scopedPublishedRead` exists to hold. That is the one real
constraint, and it is why this is a considered change rather than a wrapper applied everywhere.

### 13 — no compression, no cache headers on media

The `Caddyfile` has no `encode` directive, and `/api/media/file/*` is
`reverse_proxy web:3000` with no `Cache-Control` — so uploaded images are served through Node,
uncached, on every request when R2 is not configured.

```
# Caddyfile — once, at the proxy, not in the app
encode zstd gzip

# and for the media carve-out
handle @media_files {
    header Cache-Control "public, max-age=604800, immutable"
    reverse_proxy web:3000
}
```

`getMediaUrl` already appends `updatedAt` as a cache-busting query param, so an immutable
`max-age` on that path is safe.

### 21 — `queryPage` inherits `depth: 2`

Most reads here set `depth` explicitly and explain themselves — `queryPost` uses `depth: 1`
with a comment about the hero image and related posts being a better trade than a second query.
`queryPage`, the read behind every page view, sets `limit`, `locale`, `pagination`, `draft`,
`user` and `where` but **not `depth`**, so it takes Payload's default of 2 and populates two
levels of every relationship in every block on the page.

```ts
const { docs } = await findForSite('pages', site.id, {
  depth: 1,                    // match queryPost, which already reasons about this
  draft, limit: 1, locale, pagination: false, user,
  where: { slug: { equals: slug } },
})
```

Give `findForSite` a default (`depth = 1`) too, so a future caller that forgets cannot silently
reintroduce it.

Related, and already correctly identified in `payload.config.ts`'s own comment: `maxComplexity:
300` bounds field count but not row volume, and Payload 3.88 has no `maxLimit` — so
`Pages(limit: 100000)` is still accepted over REST and GraphQL. A `beforeOperation` hook
clamping `limit` on public collections is the missing half.

### 25 — the publish probe reads whole documents

`siteOfWrite` answers "which site does this document belong to?" so the role check can run. It
passes `depth: 0` and `disableErrors` — both right — but no `select`, so it reads every column
including the full `layout` block array. The file itself documents that Payload probes `update`
access twice per document (once as draft, once as published) to decide whether to show the
Publish button, so that is two full-document reads per permission check, including per row of an
admin list view.

```ts
const doc = await req.payload.findByID({
  id, collection, depth: 0, disableErrors: true, overrideAccess: true, req,
  select: { site: true },
})
```

Admin-side only, which is why it is P2 — but it is a one-word change.

## What passes

- **9 queries per page render, all indexed, ~0.8 ms of DB time.** No N+1 on the public path.
- **The tenant column is indexed on every registered collection** — the multi-tenant plugin sets
  `index: true` on its `site` field; verified in `pg_indexes`.
- **Access control returns `Where` constraints, not booleans** (`scopedPublicRead` /
  `scopedPublishedRead`), so scoping is pushed into SQL rather than filtered in memory — and a
  client's `where` can only narrow it, which `tests/int/headless.int.spec.ts` pins.
- **GraphQL is bounded**: `maxComplexity: 300` derived from measured queries against this
  schema, introspection and playground disabled in production.
- **Migrations are pre-run, `push` is not used in production**, and the Dockerfile is a real
  `output: 'standalone'` build on `node:24-alpine` running `node server.js` — all three of which
  the POS deployment does *not* do (see its own audit doc, finding 11).
- **Uploads generate seven sizes once at upload**, with a content-sniffed `mimeTypes` allowlist,
  R2 via `@payloadcms/storage-s3`, and per-site key prefixes.
- **Side-effect hooks are best-effort, not awaited-fatal** — `tryRevalidate`, `void` + log, with
  the at-most-once cost stated in the file.
- **`PAYMENT_GATEWAY_TIMEOUT_MS` is read per call**, not captured at module load, and defaults
  to 10 s. The POS side has two outbound clients with no timeout at all; this repo does not.
