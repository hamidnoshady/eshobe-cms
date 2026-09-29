# Eshobe CMS — Theme API Reference

**For AI agents and human developers building headless themes (including ecommerce).**

*Version: `contractVersion = 1` — `GET /api/site` returns this number. Bump = breaking change.*
*Stack: Payload 3.88 + Next 16 + Postgres + Tailwind v4. Platform is Persian-first, RTL by default, multi-tenant via `Host`.*
*Base: this repo `hamidnoshady/eshobe-cms`. Docs cover REST + Payload API, blocks, theming, i18n, money, routing and checkout.*

> **Read this once before writing code:** every date/number/price must go through `@eshobe/site-runtime` helpers, every price is integer minor units of the **site's** currency (never hardcode Toman/Rial), tenant comes from `Host` header or site API key — never from a query param/body field.

---

## Table of Contents

1. [Theme Repository Quick Start for an AI Agent](#1-theme-repository-quick-start-for-an-ai-agent)
2. [Core Concepts](#2-core-concepts)
3. [Request Fundamentals](#3-request-fundamentals)
4. [Site Descriptor — `GET /api/site`](#4-site-descriptor--get-apisite)
5. [Payload REST API — Common Query Language](#5-payload-rest-api--common-query-language)
6. [Collections Reference](#6-collections-reference)
7. [Ecommerce: Products, Store, Orders & Checkout](#7-ecommerce-products-store-orders--checkout)
8. [Page Builder Blocks](#8-page-builder-blocks)
9. [Theming — Design Tokens & CSS](#9-theming--design-tokens--css)
10. [Internationalization, Dates, Numbers & Money](#10-internationalization-dates-numbers--money)
11. [Routing & URL Helpers](#11-routing--url-helpers)
12. [Media](#12-media)
13. [SEO, Sitemap, Robots, OG](#13-seo-sitemap-robots-og)
14. [Security & Multi-Tenancy](#14-security--multi-tenancy)
15. [Rendering a Theme — Complete Example](#15-rendering-a-theme--complete-example)
16. [Headless Checklist & Build Order for an AI Agent](#16-headless-checklist--build-order-for-an-ai-agent)
17. [Errors, Rate Limits & Webhooks](#17-errors-rate-limits--webhooks)
18. [Deployable Themes and `eshobe.theme.json`](#17b-deployable-themes-and-eshobethemejson)

---

## 1. Theme Repository Quick Start for an AI Agent

Build a compatible theme repository in this order. Eshobe does **not** require a
specific frontend framework; these steps work for Next, Remix, SvelteKit, Astro, a
plain Node server, or any app that can answer HTTP.

1. Create an application that can render HTML for a site.
2. Install the runtime helpers: `pnpm add @eshobe/site-runtime`.
3. Add `eshobe.theme.json` at the repository root (full spec in §17b).
4. Implement a CMS client that uses either same-origin `/api/*`, or `ESHOBE_CMS_URL`
   plus `Authorization: Bearer $ESHOBE_API_KEY`.
5. Call `GET /api/site` before first paint.
6. Render pages and blocks from `/api/pages`, `/api/posts`, `/api/products`, etc.
7. Resolve media from `site.media.origin + site.media.basePath`.
8. For stores, implement product, cart/checkout, and payment-method flows against the
   documented ecommerce endpoints.
9. Implement `GET /api/health` (or the manifest's `build.healthCheckPath`).
10. Implement `POST /api/revalidate` and verify the signed request.
11. If `proxiesApi: true`, proxy CMS-owned `/api/site`, `/api/pages`, `/api/posts`,
    `/api/products`, `/api/checkout`, `/api/payments/*`, `/api/media/file/*`, and
    other CMS endpoints back to `ESHOBE_CMS_URL` while keeping theme-owned routes
    such as your page renderer and `/api/revalidate` local.
12. Add a Dockerfile or build-pack-compatible package scripts.
13. Push the repository to GitHub.
14. Register the repository as a Theme in Eshobe CMS.
15. Sync the manifest.
16. Build an immutable GHCR artifact or let Coolify build from source.
17. Deploy preview.
18. Publish production only after health verification.

Minimal repository layout:

```text
my-eshobe-theme/
├── eshobe.theme.json
├── package.json
├── Dockerfile
├── src/
│   ├── cms/
│   │   ├── client.ts
│   │   ├── site.ts
│   │   └── types.ts
│   ├── app/
│   └── components/
└── README.md
```

Minimal bootstrap client:

```ts
import { formatPrice, themeCss } from '@eshobe/site-runtime'

const cms = process.env.ESHOBE_CMS_URL ?? ''
const site = await fetch(`${cms || ''}/api/site`, {
  headers: process.env.ESHOBE_API_KEY
    ? { Authorization: `Bearer ${process.env.ESHOBE_API_KEY}` }
    : {},
}).then((r) => r.json())

const pages = await fetch(`${cms || ''}/api/pages?where[slug][equals]=home&locale=${site.defaultLocale}&depth=2`, {
  headers: process.env.ESHOBE_API_KEY
    ? { Authorization: `Bearer ${process.env.ESHOBE_API_KEY}` }
    : {},
}).then((r) => r.json())

const css = themeCss(site.theme)
const price = formatPrice(180000, site.store.currency, site.defaultLocale)
```

### Five calls to a working store

```ts
// 1. Bootstrap — one call tells you tenant, locales, blocks, theme tokens and runtime settings.
const site = await fetch('https://CUSTOMER_DOMAIN/api/site').then(r => r.json())

// 2. List products (public, Host-scoped, published only).
const products = await fetch(
  `https://CUSTOMER_DOMAIN/api/products?locale=${site.defaultLocale}&limit=12&sort=-createdAt&depth=1`,
).then(r => r.json())

// 3. Render a price — NEVER interpolate product.price directly.
formatPrice(products.docs[0].price, site.store.currency, site.defaultLocale)

// 4. Fetch and render a page's blocks.
const page = await fetch(`https://CUSTOMER_DOMAIN/api/pages?where[slug][equals]=home&locale=${site.defaultLocale}&depth=2`).then(r=>r.json())

// 5. Checkout — collect name/phone and POST to the Host-scoped endpoint.
const checkout = await fetch('https://CUSTOMER_DOMAIN/api/checkout', {
  method:'POST',
  headers:{'content-type':'application/json'},
  body: JSON.stringify({ product: products.docs[0].id, quantity:1, name:'علی رضایی', phone:'09121234567' }),
}).then(r=>r.json())
```

The rest of this document explains every field, edge case, and invariant behind those calls.

---

## 2. Core Concepts

### Multi-tenancy: one deployment, many sites
- One Postgres, one Next process. Every content row has a `site` FK to `sites`.
- Tenant is resolved from the **`Host` header** (`siteFromRequest` / `src/lib/site-query.ts`). No endpoint accepts `?site=` — that would be a leak.
- For headless clients **not on the customer's domain** (mobile app, POS, external renderer), tenant is resolved from **`Authorization: Bearer <site API key>`** (`role: "site"`). Host is tried first, key second.
- Anonymous REST reads are **scoped at the access layer** (`src/access/siteRead.ts`). A `where[site][equals]=OTHER_ID` is ANDed with the host's site and returns nothing. Verified by `tests/int/headless.int.spec.ts`.

### Sites have a lifecycle, not a delete
`sites.status: "active" | "suspended" | "archived"`
- `active` → serves content.
- `suspended|archived` → every path returns a holding page (`SiteHolding`), 200 + `noindex`, no content. Do not delete a site (FK orphans, `cleanupAfterTenantDelete: false`).

### Persian-first
- `defaultLocale = "fa"`, `rtl:true` on fa. `dir` comes from the locale per request, never hardcoded.
- Vazirmatn is the only font. Body `line-height` default 1.8.
- Every date → `formatDate()`, every number → `formatNumber()`, every price → `formatPrice()` — all in `@eshobe/site-runtime`. No raw `toLocaleDateString()`.

### Money is integer minor units
- Stored price `120000` with `site.store.currency = "IRT"` means 120,000 Toman.
- Conversion `IRT ↔ IRR` lives exactly once in `src/lib/money.ts` (`1 تومان = 10 ریال`) — never in theme code.
- Product has **no** `currency` field; site does.

### Pages vs Site Routes
- Pages collection holds CMS pages. Some URLs are **reserved site routes** that are not pages: `/posts`, `/posts/<slug>`, `/search`, `/checkout/<order>`, `/products/<slug>`. Saving a page with slug `posts` is rejected (`reservedPageSlug` hook). Resolve URLs through `resolveSiteRoute()` in `@eshobe/site-runtime/slug`.

---

## 3. Request Fundamentals

### Base URL
```
https://<customer-domain>          # storefront (customer's own domain)
https://<control-plane-host>        # admin + Payload API (your deployment origin)
http://acme.localhost:3000          # local dev (Windows needs hosts entries via scripts/dev-hosts.ps1)
```

### Host Header Is the Tenant
In dev/browser, `fetch('https://acme.localhost:3000/api/site')` automatically sends `Host: acme.localhost`. In server-to-server or AI agent code, explicitly set it:

```ts
fetch('https://cms.example.com/api/site', {
  headers: { Host: 'acme.ir' } // tenant selection
})
// Or with API key (non-customer origin):
fetch('https://cms.example.com/api/site', {
  headers: { Authorization: 'Bearer eshobe_live_abc123...' }
})
```

> **A deployed theme uses the key, not `Host`.** `ESHOBE_CMS_URL` is the CMS's public
> address, usually behind the same Coolify/Traefik proxy that serves the theme — and that
> proxy routes by `Host`. Rewriting `Host` to the customer domain sends the request back
> into the theme's own container (production) or to no router at all (preview): every
> lookup times out and the site renders empty. Send `Authorization: Bearer
> $ESHOBE_API_KEY` with the CMS's own `Host`. A site key scopes every public read —
> pages, posts, categories, header, footer, media — to its site, and also reads drafts,
> so filter `where[_status][equals]=published` yourself and never attach the key to
> visitor traffic other than draft-free reads (`/api/site`, `/api/media/file/*`).

### CORS
`payload.config.ts` `cors: [ getServerSideURL(), ...API_CORS_ORIGINS ]`. Extra origins must be listed in `API_CORS_ORIGINS` env (comma-separated) to allow credentialed requests. No wildcard.

### Common Query Params (Payload REST)
All collections share:


| Param | Example | Notes |
|-------|---------|-------|
| `locale` | `?locale=fa` | Active locale. Falls back to site's `defaultLocale` if omitted. Reads honor `fallback:true` |
| `fallbackLocale` | `&fallbackLocale=false` | Set `false` when enumerating hreflang/sitemap — otherwise untranslated slug returns Persian slug and advertises a 404 URL |
| `depth` | `&depth=1` | Populate relationships to this depth. `0` = ids only. Use `1` for media/images, `2` sparingly |
| `select` | `&select[title]=true&select[slug]=true` | Limit columns (also `defaultPopulate`) |
| `where` | `&where[slug][equals]=home` | See Payload where syntax below |
| `sort` | `&sort=-publishedAt` | `-` = desc |
| `limit` / `page` | `&limit=12&page=2` | `pagination:false` to disable |
| `draft` | `&draft=true` | Only with authenticated user/key (see auth). Anonymous drafts are always hidden |
| `overrideAccess` | — | **Never** on REST — Local API only, always `false` on frontend |

### `where` Syntax (Payload)
```
where[field][operator]=value
operators: equals, not_equals, in, not_in, greater_than, less_than, like, exists
nest with and/or: where[and][0][slug][equals]=home
```
Example: pages by slug and published only is enforced server-side, but you write:
```
GET /api/pages?where[slug][equals]=درباره-ما&locale=fa
```

### Auth Headers

| Credential | Header | Access |
|------------|--------|--------|
| Anonymous visitor | _(none)_ | Published + tenant-scoped only |
| Logged-in Payload user | `Cookie: payload-token=...` or `Authorization: JWT ...` via `/api/users/login` | Drafts + own sites (multi-tenant plugin) |
| Site API key (`role:"site"`) | `Authorization: Bearer eshobe_live_...` | Its site's content incl. drafts, create/update on pages/posts/products, read/update status on orders |
| Platform API key (`role:"platform"`) | `Authorization: Bearer eshobe_live_...` | `GET /api/sites`, `POST /api/provision-site`, `POST /api/api-keys/*` — **no content** |

Site key `id` is the `site` FK — the key **is** the tenant, not a filter.

### Content-Type & Locale Digits
- POST bodies are JSON unless uploading media (`multipart/form-data`).
- Phone/price inputs accept Persian digits (`۰۹۱۲`) — `toAsciiDigits()` normalizes. Display with `toLocaleDigits()`.

---

## 4. Site Descriptor — `GET /api/site`

**The one call before first paint.** Returns per-tenant bootstrap so a headless renderer never hardcodes locales, blocks, currency or theme.

### Request
```http
GET /api/site HTTP/1.1
Host: acme.ir
# Or: Authorization: Bearer eshobe_live_...
Accept: application/json
```

### Responses

**200 — known host**
```json
{
  "availableLocales": ["fa", "en"],
  "blocks": ["content","mediaBlock","cta","features","testimonials","faq","contact","formBlock","productGrid","gallery","team","pricing","logos","archive"],
  "contractVersion": 1,
  "defaultLocale": "fa",
  "domain": "acme.ir",
  "branding": {
    "displayName": "فروشگاه نمونه", "shortName": null, "tagline": null,
    "primaryLogo": { "id": "…", "url": "/api/media/file/logo.svg", "mimeType": "image/svg+xml", "width": 120, "height": 40, "alt": null, "updatedAt": "…" },
    "compactLogo": null, "homeLogo": null, "lightLogo": null, "darkLogo": null, "favicon": null, "socialImage": null,
    "displayNameFa": "فروشگاه نمونه", "logo": { "…": "= primaryLogo" }, "logoCompact": { "…": "= compactLogo, else primaryLogo" }, "defaultOgImage": { "…": "= socialImage" }
  },
  "media": { "basePath": "/api/media/file", "origin": "https://acme.ir" },
  "name": "فروشگاه نمونه",
  "slug": "acme",
  "status": "active",
  "store": { "currency": "IRT", "paymentProvider": "bank" },
  "theme": { "primary": "#0f766e", "accent": "#f59e0b", "background": "#ffffff", "foreground": "#0a0a0a", "radius": "md", "lineHeight": 1.8 },
  "themeRuntime": {
    "theme": { "key": "graphite" },
    "package": { "key": "graphite" },
    "settings": {},
    "bindings": {}
  },
  "type": "store"
}
```

When resolved via **site API key** (not Host), two extra fields appear (pinned by test — anonymous never gets them):
```json
{ "id": "uuid...", "domainVerified": true, "...": "..." }
```

`themeRuntime.theme.key` is the public theme identity. `themeRuntime.package.key` is kept
for backward compatibility with older deployed themes. The descriptor never exposes theme
package database IDs, Coolify UUIDs, server UUIDs, registry credentials, site API keys,
revalidation secrets, tenant secret values or encrypted ciphertext.

**404 — unknown host**
```json
{ "error": "unknown-host" }
```

### Branding and logos
`branding` is the customer's identity; every media value is `{ id, url, alt, mimeType, width, height, updatedAt }` or `null`.
- `homeLogo` — the large mark a landing page shows (an intro animation, for instance). The customer uploads it in **هویت بصری › نشان صفحهٔ نخست**; **SVG is accepted**. A theme with such a place renders `homeLogo ?? primaryLogo`, and falls back to the site name as a wordmark when both are `null` — never to bundled artwork.
- `logo`, `logoCompact`, `defaultOgImage`, `displayNameFa` are aliases of `primaryLogo`, `compactLogo` (else `primaryLogo`), `socialImage` and `displayName`, sent so a theme written against either spelling gets its logo.
- An uploaded SVG has passed an allowlist (`src/lib/svg.ts`): drawing elements only, no script, no external references, ≤ 200 KB. Render it with `<img src>` (as with any raster) — never inline the fetched markup into the page.

### Headers & Caching
- Success: `cache-control: public, s-maxage=30, stale-while-revalidate=300`, `vary: Host`, `etag: "<sha256>"`, `last-modified: <latest of site/store/theme updatedAt>`
- `If-None-Match` → `304` when ETag matches.
- API-key-resolved: `cache-control: private, no-store` (no Host to vary on, can't share cache).

### Why each field matters
- `availableLocales` + `defaultLocale` → prefix URLs correctly, 404 unserved locales (don't fall back to duplicating home page under `/de`).
- `blocks` → same allowlist the admin picker uses; warn in theme if layout contains unknown `blockType`.
- `store.currency` → the unit label (`تومان` vs `Toman`) and math.
- `theme` → emit as CSS variables (see §9).
- `media.origin` → `new URL(media.url, site.media.origin)`. `media.url` is always relative (`/api/media/file/…`), served through the CMS proxy so the object-storage bucket stays private.

### cURL
```bash
curl -H "Host: acme.ir" https://cms.example.com/api/site | jq
curl -H "Authorization: Bearer eshobe_live_$(cat key)" https://cms.example.com/api/site | jq
# ETag check
curl -H "Host: acme.ir" -H "If-None-Match: \"abc\"" https://cms.example.com/api/site -i
```

### TS
```ts
const res = await fetch(`${CMS_ORIGIN}/api/site`, { headers: { Host: siteDomain } })
if (res.status === 404) throw new Error('unknown host')
const site = await res.json() as SiteDescriptor
```

Type `SiteDescriptor` shape is above; `contractVersion` is `1` from `@eshobe/site-runtime`.

---

## 5. Payload REST API — Common Query Language

All content collections are exposed at `GET /api/<slug>` with Payload's REST shape.

### Generic Response Envelope
```json
{
  "docs": [ { "id":"...", "title":"...", "slug":"...", "_status":"published", "createdAt":"...", "updatedAt":"..." } ],
  "totalDocs": 42,
  "limit": 10,
  "totalPages": 5,
  "page": 1,
  "pagingCounter": 1,
  "hasPrevPage": false,
  "hasNextPage": true,
  "prevPage": null,
  "nextPage": 2
}
```
With `?pagination=false&limit=1` you get `{ docs, totalDocs, ... }` with no paging calc.

### Single Document
```
GET /api/pages/<id>?locale=fa&depth=1
GET /api/products/<id>?locale=fa
```
Also by slug: `GET /api/pages?where[slug][equals]=home&locale=fa&limit=1`

### Locale Rules (critical for themes)
- Content slugs are **localized** (`slugField { localized:true }`). A page may have slug `درباره-ما` in `fa` and `about` in `en`.
- With `localization.fallback:true` (global), a missing `en` translation falls back to Persian payload — but `where[slug][equals]=about` with `fallback:true` still only matches the `en` row, so URL enumeration must use `fallbackLocale=false` to avoid advertising Persian URLs as English ones.
- Theme: read `Accept-Language` or path prefix, but **trust `site.availableLocales`**: if URL's locale segment not in that list → `404` (see `localeIsServed`).

### Depth & Select
- `depth` costs DB joins. Default is `0`. Use `1` for rendering a product card with its `image` populated. Never `depth=2` on a list — fetch one doc deeper instead.
- `select` trims payload and DB read: `?select[title]=true&select[slug]=true&select[price]=true`

### Tenancy & Visibility
- Anonymous: `where` includes `{ _status:{equals:"published"} }` automatically on pages/posts/products (`scopedPublishedRead`). Drafts never leak.
- Site key: sees drafts for its site, and constraint is `{site:{equals: key.siteId}}` regardless of `where`.
- Logged-in user: multi-tenant plugin narrows to their `tenants[].site` set.

---

## 6. Collections Reference

All collections below have an implicit `site` relationship (UUID, `relationTo: "sites"`) added by the multi-tenant plugin, except `sites` and `users` themselves. Collections marked `isGlobal: true` have exactly one doc per site.

### `sites` — tenants
`GET /api/sites` requires `authenticated` (platform admin or platform key via `platformApiKeyAware`).

| Field | Type | Notes |
|-------|------|-------|
| `name` | text, required | Display name |
| `domain` | text, unique, required | Bare host (`acme.ir`), validated `/^[a-z0-9.-]+$/` — no protocol/port/path |
| `domainVerified` | checkbox, default false | Field-level `update: platformAdmin` — only platform admin flips |
| `type` | select `business|portfolio|store`, default `business` | Gates blocks (see §8) |
| `status` | select `active|suspended|archived`, default `active` | Lifecycle |
| `availableLocales` | select hasMany `fa|en`, default `["fa"]` | Not called `locales` (would clash with Payload's `sites_locales` table) |
| `defaultLocale` | select `fa|en`, default `fa` | Validated to be inside `availableLocales` |
| `slug` | text, auto from `name` via `slugifyField` | Internal id, not a URL |
| `updatedAt/createdAt` | date | |

REST: `GET /api/sites?where[domain][equals]=acme.ir`

### `pages` — CMS pages
`access: read = apiKeyAware(scopedPublishedRead(authenticatedOrPublished))`, draft autosave 375ms, `schedulePublish` true.

| Field | Type | Notes |
|-------|------|-------|
| `title` | text, localized, required | |
| `slug` | text, localized, required | Validated unique per `{site, locale}` + not in `RESERVED_PAGE_SLUGS` (`posts`, `search`, `checkout`) |
| `hero` | group | `type: none|highImpact|mediumImpact|lowImpact`, `richText` (lexical, localized), `links[]`, `media` |
| `layout` | blocks[], required | Not localized (see explanation below). Filtered by `allowedBlocks` (site.type → slugs). Contains 14 block types (§8) |
| `meta` | group | SEO: `title` (localized), `image` (media), `description` (localized) |
| `publishedAt` | date | Sidebar, with `ShamsiDateHint` component |
| `_status` | `draft|published` | Versions |
| `site` | relation `sites` | |

`layout` is **not localized** — localizing a container would give each locale its own block list → editors rebuild whole page per language. Instead each block's text fields carry `localized:true`. Preserve each block row's `id` when updating via Local API across locales or you clobber the other locale.

Query by slug (page routing):
```bash
GET /api/pages?where[slug][equals]=home&locale=fa&depth=1&limit=1
# Home page uses slug "home" internally, but URL is "/" — see pagePath() in §11
```

### `posts` — blog
Same access as pages. `defaultPopulate: {title, slug, categories, meta:{image,description}}`

| Field | Type | Notes |
|-------|------|-------|
| `title` | text, localized, required | |
| `slug` | text, localized, unique per site+locale | |
| `heroImage` | upload `media` | |
| `content` | richText lexical, localized, required | Features: headings h1-h4, Banner/Code/MediaBlock, FixedToolbar |
| `relatedPosts` | relationship `posts` hasMany | Filtered to exclude self |
| `categories` | relationship `categories` hasMany | |
| `meta` | group | as pages |
| `publishedAt` | date | auto-set on publish |
| `authors` | relationship `users` hasMany | |
| `populatedAuthors` | array {id,name} | Filled by `populateAuthors` hook (privacy-safe) |
| `site`, `_status`, `slug` etc | | |

Query:
```bash
GET /api/posts?limit=10&sort=-publishedAt&locale=fa&where[_status][equals]=published
GET /api/posts?where[slug][equals]=first-post&locale=fa&depth=1
```

### `products` — store catalogue
`access: read = apiKeyAware(scopedPublishedRead(...))`, `create/update: apiKeyCreateAware/writeUnlessPublishing` + `forceApiKeySite`.

| Field | Type | Notes |
|-------|------|-------|
| `title` | text, localized, required | |
| `slug` | text, localized, required, unique per site+locale | Auto via `slugifyField` (Persian-safe, see §10) |
| `summary` | textarea, localized | Subtitle on card |
| `image` | upload `media` | Optional — no filler required, card keeps shape |
| `price` | number, required, min 0 | **Integer minor units** of site currency. Validated `validatePriceMinor` — no float/negative |
| `compareAtPrice` | number, min 0 | Strikethrough price, optional |
| `sku` | text, indexed | Internal, not shown |
| `trackInventory` | checkbox, default false | `false` → unlimited |
| `inventory` | number, min 0, required when `trackInventory` true | Decremented on `orders.status→paid` via `settleStock` hook |
| `site`, `_status` | | |

Prices: `price=180000` with `IRT` = 180,000 Toman. Display only via `formatPrice(price, currency, locale)`.

```bash
GET /api/products?where[slug][equals]=chair&locale=fa&depth=1
GET /api/products?limit=12&sort=-createdAt&locale=fa   # catalogue
# Relationships: GET /api/products/<id>?depth=1&locale=fa → image populated
```

### `orders` — headless only
`access: read/update = apiKeyAware(authenticated)` (no public read). **Never fetch via REST anonymously.** Buyers see their order only through a signed receipt URL (see §7). Headless store operators use site API key.

| Field | Type | Notes |
|-------|------|-------|
| `reference` | text, required, indexed, readOnly | Random `newOrderReference()` — not sequential (prevents volume leakage) |
| `status` | select `pending|paid|cancelled|refunded`, default `pending` | |
| `product` | relationship `products`, required, maxDepth 1 | |
| `productTitle` | text, readOnly | Snapshot at order time |
| `quantity` | number, 1..MAX_ORDER_QUANTITY | MAX_ORDER_QUANTITY is env-tunable, default ~10 |
| `unitPrice` | number, required, readOnly | Snapshot of `product.price` |
| `total` | number, required, readOnly | `unitPrice * quantity` |
| `currency` | select `IRT|IRR|USD|EUR`, required, readOnly | Snapshot of site's `store.currency` |
| `buyer` | group | `name` text required, `phone` text required (normalized, validated `/^0?9\d{9}$/`), `email` email?, `note` textarea? |
| `payment` | group | `provider: bank|http` required, `reference` text?, `paidAt` date? |
| `site` | relation | |

List with site key:
```bash
GET /api/orders?where[status][equals]=pending&sort=-createdAt&limit=20
# update status only — access hook restricts writable field to status:
PATCH /api/orders/<id>  { "status":"paid" }   # with site key
```

### `store` — per-site settings (`isGlobal: true`)
`access: read = scopedPublicRead()` (public so storefront can format prices), `paymentInstructions` field has `read: ({req:{user}})=>Boolean(user)` — **not in public response**.

| Field | Type | Notes |
|-------|------|-------|
| `currency` | select `IRT|IRR|USD|EUR`, default `IRT` | Persian label: `IRT` is `تومان (پیش‌فرض)`, `IRR` is `ریال (واحد رسمی — ۱۰ ریال = ۱ تومان)` |
| `paymentProvider` | select `bank|http`, default `bank` | |
| `paymentInstructions` | textarea, localized, field-level auth | Card number / transfer text. Only staff / receipt read |

Public read (no key, on customer's Host):
```bash
GET /api/store?locale=fa&limit=1 # via Host — store is isGlobal, one doc per site
# → { currency:"IRT", paymentProvider:"bank" }  (paymentInstructions omitted)
```

With site key or logged-in user, `paymentInstructions` appears. On `GET /api/site` it is **never** included — store there is `{currency,paymentProvider}` only. For the buyer's receipt, use `readOrderDocs` (server-side, see §7).

### `theme` — per-site tokens (`isGlobal: true`)
`access: read = scopedPublicRead()`

| Field | Type | Default |
|-------|------|---------|
| `primary` | text (hex `#rgb`/`#rrggbb`) | `#0f766e` |
| `accent` | text hex | `#f59e0b` |
| `background` | text hex | `#ffffff` |
| `foreground` | text hex | `#0a0a0a` |
| `radius` | select `none|sm|md|lg`, default `md` | Maps to `0 | 0.25rem | 0.625rem | 1rem` |
| `lineHeight` | number 1.4..2.4, default 1.8 | Body leading (Persian needs ~1.8) |

See §9 for how to emit.

### `media` — uploads
`access: read = scopedPublicRead(anyone)` (public, Host-scoped). Tenant-isolated via `setMediaPrefix` (object-storage key `sites/<id>/media/<filename>`). Local dev serves from `public/media` or `MEDIA_DIR`.

| Field | Type |
|-------|------|
| `alt` | text, localized |
| `caption` | richText lexical, localized |
| `prefix` | text, auto (object-storage namespace) |
| `folder` | relation `payload-folders` |
| `url`, `thumbnailURL`, `filename`, `mimeType`, `filesize`, `width`, `height`, `sizes` | auto (Payload upload) |

Accepted types: JPEG, PNG, WebP, GIF, AVIF, and **SVG** that passes the allowlist in `src/lib/svg.ts` (anything with script, `<image>`, `<a>`, `<foreignObject>`, animation or an external reference is refused with a Persian reason). SVG has no `sizes`.

Image sizes: `thumbnail 300w`, `square 500×500`, `small 600w`, `medium 900w`, `large 1400w`, `xlarge 1920w`, `og 1200×630 crop:center`.

Building an `<img>`:
```ts
const src = new URL(media.url!, site.media.origin).toString()
// or a size: media.sizes?.medium?.url → new URL(size.url!, site.media.origin)
```

### `categories` — hierarchical
`access: nestedDocsPlugin` (tree via `parent` + `breadcrumbs`).

| Field | Type |
|-------|------|
| `title` | text, required |
| `slug` | auto via `slugify` |
| `parent` | relation `categories` self |
| `breadcrumbs` | array {doc, url, label} auto via `nestedDocsPlugin` |
| `site` |  |

### `header` / `footer` — per-site singletons (`isGlobal: true`)
`access: read = scopedPublicRead()` — nav belongs to site.

| Field | Type |
|-------|------|
| `navItems` | array { link: { type: reference|custom, reference: pages|posts, url, label, newTab, appearance } } | Header links use appearance `default|outline` |

### `forms` / `form-submissions` — form builder
`forms` is admin-edited. `form-submissions` is `create: () => true` (public), but `beforeValidate` derives `site` from the `form` doc's site — client cannot choose tenant.

Submit headlessly (POST, Host-scoped):
```bash
POST /api/form-submissions
{ "form":"<formId>", "submissionData":[{"field":"name","value":"علی"}, {"field":"email","value":"..."}] }
# site field is ignored / overridden from form.site
```

### `search` — index of `posts`
`access: read = scopedPublicRead(anyone)` (indexed `title` + SEO `description`). So search cannot bypass `siteRead`.

Query:
```bash
GET /api/search?where[title][like]=یادداشت&limit=10&locale=fa
# docs: { title, slug, doc:{relationTo:"posts", value:"<id>"}, meta, categories }
```

Render search page headlessly: `/search?q=...` is a site route (`src/app/(site)/[domain]/[[...path]]`), not a collection. `SearchResults` does:
```
GET /api/search?where[or][0][title][like]=q&... + ?depth=1 for posts?
```
But use Payload's `where` on `search` as above, then fetch each `doc.value` as a post.

### `redirects` — per-site
`from: text` (source path), `to: {type, reference: pages|posts, url}`. Hook `revalidateRedirects` clears cache.

### `users` / `api-keys`
Not theme-rendered. `users.tenants[]: {tenant: siteId, role: owner|editor}`. `api-keys`: see §3 Auth. Only listing via `GET /api/api-keys/list?siteId=` with platform key (see §17).

---

## 7. Ecommerce: Products, Store, Orders & Checkout

### Concept: Catalog + Checkout First (no cart)
- No cart document — one buy button → one `orders` row. A cart is a future block.
- Inventory is optional per product (`trackInventory`). When `true`, order completion decrements `inventory` by `quantity` (hook `settleStock`). Exhausted product returns `409` with `available`.
- Currency is site-global (from `store`), not per-product. All four codes: `IRT` (Toman, default), `IRR` (Rial), `USD`, `EUR`. Theme never shows a price without a unit — use `formatPrice()`.

### Product Listing (headless)

```ts
// Collection or manual selection per ProductGrid block:
// block = { slug:"productGrid", populateBy:"collection"|"selection", limit:6, products:[ids], columns:"3", showBuyButton:true }
async function fetchProductsForBlock(siteDomain:string, locale:string, block:any) {
  if (block.populateBy === 'selection' && block.products?.length) {
    // expand ids — respect depth for image
    const ids = block.products.map((p:any)=> typeof p==='string'?p:p.id)
    const q = ids.map((id:string,i:number)=>`where[or][${i}][id][equals]=${id}`).join('&')
    return fetch(`https://${siteDomain}/api/products?${q}&locale=${locale}&depth=1`).then(r=>r.json())
  }
  // collection: newest first
  return fetch(`https://${siteDomain}/api/products?limit=${block.limit ?? 6}&sort=-createdAt&locale=${locale}&depth=1`).then(r=>r.json())
}
```

Product URL: `productPath(slug)` → `/products/<slug>` then `localeHref()` → `/en/products/...` when not default.

Product detail:
```bash
GET /api/products?where[slug][equals]=my-product&locale=fa&depth=1&limit=1
# produces: { docs:[{title, slug, price, compareAtPrice, image:{url}, ...}], ... }
```

### Store Settings Fetch
```ts
// Public: on customer's Host
GET /api/store?locale=fa&limit=1    // → { docs:[{currency:"IRT", paymentProvider:"bank"}] }
// Or via site descriptor (preferred)
GET /api/site  // → { store:{currency,paymentProvider} }
```

### Checkout Flow — the only write a visitor does

**Two halves:** `POST /api/checkout` (initiate) → PSP handoff → `GET/POST /api/checkout/callback?order=<id>` (verify server-to-server) → receipt.

#### 1. Initiate — `POST /api/checkout`
- **Tenant from `Host`, not body.** Body's `site` (if sent) is ignored.
- Validates `productId` is UUID, product is published and belongs to this site, `quantity` 1..MAX, buyer `name`+`phone`, optional `email`/`note`.
- Phone normalized: Persian digits accepted, stored ASCII. Valid `/^0?9\d{9}$/`.
- Price is **never** from body — `unitPrice` and `total` read from product row, `currency` from store.
- Guards: per-IP fixed-window throttle (`CHECKOUT_RATE_LIMIT` env, default 20/10min, `Retry-After` on 429) + per-`phone+product+site` duplicate pending refusal (15 min, env `CHECKOUT_DUPLICATE_WINDOW_MINUTES`). Duplicate does **not** return existing receipt link (would be oracle).

**Request:**
```http
POST /api/checkout HTTP/1.1
Host: acme.ir
Content-Type: application/json

{
  "product": "550e8400-e29b-41d4-a716-446655440000",
  "quantity": 1,
  "name": "علی رضایی",
  "phone": "۰۹۱۲۳۴۵۶۷۸۹",     // Persian digits ok
  "email": "ali@example.com",  // optional, must contain @
  "note": "لطفاً قبل ارسال تماس بگیرید",  // optional, max 500
  "company": ""               // honeypot — TRAP: non-empty = silently fake 200 (bot)
}
```
`product` is UUID `id` of `products`, not slug.

**Responses:**

*200 — with PSP redirect*
```json
{ "ok": true, "redirectUrl": "https://psp.example/pay/txn_123", "confirmationUrl": "/checkout/<orderId>?r=<sig>" }
```
Redirect browser to `redirectUrl`. If null (bank provider or PSP not configured), go to `confirmationUrl`.

*503 — PSP not configured / initiate failed, but order is pending*
```json
{ "ok": true, "pending": true, "confirmationUrl": "/checkout/<id>?r=...", "message": "درگاه پرداخت این سایت پیکربندی نشده است." }
```

*429 — rate limited*
```json
{ "ok": false, "message": "چند لحظه صبر کنید و دوباره تلاش کنید." }
// header: retry-after: <seconds>
```

*409 — inventory or duplicate*
```json
{ "ok": false, "available": 0, "message": "این محصول تمام شده است." }
{ "ok": false, "available": 3, "message": "تنها 3 عدد از این محصول موجود است." }
{ "ok": false, "message": "شما همین حالا یک سفارش در انتظار پرداخت دارید..." }
```

*400 — validation*  `{ "message":"product id missing or malformed" }` etc.

**cURL:**
```bash
curl -X POST "https://acme.ir/api/checkout" \
  -H "Content-Type: application/json" \
  -d '{"product":"550e...","quantity":1,"name":"علی","phone":"09121234567"}' | jq
```

**JS (with Honeypot):**
```ts
// In your theme's ProductCard form, include invisible input name="company"
// Humans leave it empty. Bots fill it and get fake 200 with no order created.
```

#### 2. Callback — `GET /api/checkout/callback?order=<uuid>`
Called by **PSP server** (POST) and **browser return** (GET). Same handler, different response:
- Verifies money **server-to-server** via `provider.confirm({ order, paymentReference, req })`. Query `status=ok` proves nothing.
- Idempotent: if `order.status==="paid"` → no double settle.
- On success, updates order `{status:"paid", payment:{paidAt, reference}}` with `overrideAccess:true`, then fires `sendOrderReceipt` email (best-effort, `void`+log, never fails the response).
- GET: `302` to `confirmationUrl` (`/checkout/<id>?r=<sig>`).
- POST: `200 {ok:true,status}`.

Bank provider has **no** `provider.confirm` → returns `{ok:true}` with message *"پس از واریز، فروشگاه آن را تأیید می‌کند"* — owner settles `paid` by hand in admin.

For a theme, you **don't call the callback** — the PSP does. Your confirmation page does:

#### 3. Receipt — `GET /checkout/<orderId>?r=<signature>`
Not an API endpoint — a Next.js page `CheckoutReceipt.tsx` rendered at `src/app/(site)/[domain]/[[...path]]`. It verifies `r` with `verifyOrderReceipt({orderId, receipt, siteId})` (`HMAC-SHA256(PAYLOAD_SECRET, "eshobe-order-receipt:v1:${siteId}:${orderId}")`). Without valid `r`, no order is shown.

Data fetched server-side via `readOrderDocs(payload, orderId, siteId, locale)` — also pulls `paymentInstructions` localized in page's locale.

**To reconstruct headlessly** (e.g., email, external renderer):
```ts
import { signOrderReceipt, verifyOrderReceipt } from '@eshobe/site-runtime' // or src/lib/order-receipt
// Sign:
const r = signOrderReceipt({ orderId, siteId }) // needs PAYLOAD_SECRET
const url = `/checkout/${orderId}?r=${encodeURIComponent(r)}` // then localeHref(url, locale, site.defaultLocale)

// Verify on render:
if (!verifyOrderReceipt({ orderId, receipt: searchParams.r, siteId })) notFound()
// Then:
const order = await payload.find({ collection:"orders", where:{and:[{id:{equals:orderId}},{site:{equals:siteId}}]}, overrideAccess:true, locale })
const store = await payload.find({ collection:"store", where:{site:{equals:siteId}}, overrideAccess:true, locale })
const instructions = store.docs[0]?.paymentInstructions
```

**Payment Providers:**
```ts
// src/payments
resolvePaymentProvider(name?:string) // "bank" | "http", fallback "bank"
paymentProviderOptions // for admin select
// env for http provider (PSP over generic HTTP contract):
// PAYMENT_HTTP_INIT_URL, PAYMENT_HTTP_VERIFY_URL, etc. — without them, http provider throws PaymentGatewayNotConfigured → 503 pending response
```

#### Inventory Settling
Hook `settleStock` runs `afterChange` on `orders`: when status transitions to `paid` and `product.trackInventory`, decrement `products.inventory`. If inventory would go negative, the transition is blocked (?) — actually initiated checkout already checks, but settling is authoritative. Ensure you render inventory state fresh from product doc after purchase.

---

## 8. Page Builder Blocks

All blocks below map to `src/blocks/<Name>/config.ts`. Availability per site type is a typed table (`src/blocks/index.ts`):

| Slug | Site types | Label |
|------|------------|------|
| `content` | all | Content columns |
| `mediaBlock` | all | Image |
| `cta` | all | Call to action |
| `features` | all | Features grid |
| `testimonials` | all | Quotes |
| `faq` | all | FAQ accordion |
| `contact` | all | Address/phones |
| `formBlock` | all | Form embed |
| `productGrid` | `store` only | Store catalogue |
| `gallery` | `portfolio`, `business` | Image gallery |
| `team` | `business`, `portfolio` | Team members |
| `pricing` | `business`, `store` | Pricing plans |
| `logos` | `business`, `store` | Customer logos |
| `archive` | `business`, `portfolio` | Posts archive |

`GET /api/site` returns the allowed slugs for that site's `type` — use it to validate layout.

### Fields shared
- `sectionIntro` (in `src/blocks/fields.ts`): optional `heading` (text, localized), `intro` (textarea, localized). Most blocks spread `...sectionIntro`.
- `columnsField`: `columns: "2"|"3"|"4"` grid columns.

### Block Schemas (fields you render)

#### `content` — columns of rich text + optional link
```json
{ "blockType":"content", "columns":[
  { "size":"oneThird|half|twoThirds|full", "richText":{ "root":{...lexical }}, "enableLink":false, "link":{ "type":"reference|custom", "reference":{relationTo:"pages|posts", value:id}, "url":"...", "label":"..." } }
]}
```

#### `mediaBlock`
```json
{ "blockType":"mediaBlock", "media": "<mediaId | Media>" }  // depth controls which
```

#### `cta`
```json
{ "blockType":"cta", "richText":{ "root":{...} }, "links":[{"link":{ "type":"reference|custom","label":"...","url":"...", "reference":{...}, "appearance":"default|outline" }}] }
```

#### `features`
```json
{ "blockType":"features", "heading":"...", "intro":"...", "columns":"3", "items":[
  { "title":"...", "description":"...", "icon":"<mediaId|Media>" }
]}
```

#### `testimonials`
```json
{ "blockType":"testimonials", "heading":"...", "intro":"...", "items":[
  { "quote":"...", "author":"...", "role":"...", "avatar":"<mediaId|Media>"}
]}
```

#### `faq`
```json
{ "blockType":"faq", "heading":"...", "intro":"...", "items":[
  { "question":"...", "answer":"..." }  // both localized
]}
```

#### `contact`
```json
{ "blockType":"contact", "heading":"...", "intro":"...", "address":"...", "phones":["0912..."], "email":"...", "hours":"..." }
```
Render phones with `toLocaleDigits(phone, locale)`.

#### `formBlock`
```json
{ "blockType":"formBlock", "form":"<formId | Form>", "enableIntro":false, "introContent":{ "root":{...}}}
```
Fetch `Form` separately for its `fields[]` → render form inputs (see Forms in §6).

#### `productGrid` — **ecommerce**
```json
{
  "blockType":"productGrid",
  "heading":"...",
  "intro":"...",
  "populateBy":"collection|selection",
  "limit": 6,                    // when collection, 1..24
  "products":["<productId>"...], // when selection
  "columns":"2|3|4",
  "showBuyButton": true           // false → catalogue only, price stays, no purchase form
}
```
Render by fetching products as in §7. Price via `formatPrice(product.price, site.store.currency, locale)`. Buy button → `POST /api/checkout` with `product.id`. See PurchaseForm: `src/blocks/ProductGrid/PurchaseForm.tsx` for honeypot + quantity handling.

#### `gallery`
```json
{ "blockType":"gallery", "heading":"...", "intro":"...", "columns":"3", "images":["<mediaId>"...] }
```

#### `team`
```json
{ "blockType":"team", "heading":"...", "intro":"...", "columns":"3", "members":[
  { "name":"...", "role":"...", "bio":"...", "photo":"<mediaId>"}
]}
```

#### `pricing`
```json
{ "blockType":"pricing", "heading":"...", "intro":"...", "plans":[
  { "name":"...", "featured":false, "price":50000, "unit":"تومان", "period":"ماهانه", "features":["...","..."], "enableLink":false, "link":{...} }
]}
```
Note: `plan.price` is the plan's own number (not minor currency math) — render with `formatNumber(plan.price, locale)` + `unit`.

#### `logos`
```json
{ "blockType":"logos", "heading":"...", "intro":"...", "logos":["<mediaId>"...] }
```

#### `archive` — posts
```json
{
  "blockType":"archive",
  "introContent":{ "root":{...}},
  "populateBy":"collection|selection",
  "relationTo":"posts",          // always posts
  "categories":["<catId>"...],   // filter when collection
  "limit":10,
  "selectedDocs":[{"relationTo":"posts","value":"<id>"}]
}
```
When `collection`, fetch posts: `GET /api/posts?where[categories][in][]=...&limit=...&sort=-publishedAt`. When `selection`, expand `selectedDocs[].value`.

### Rendering Checklist
- Wrap each block's richText with `<div dir="{field.direction}">` from lexical `data.root.direction` — a field can hold English quote inside Persian page and needs its own dir. Fallback to page locale dir, but prefer field's dir with `unicode-bidi: plaintext` CSS (see `globals.css`).
- Never `data.layout` without `id` preservation on writes across locales.
- Unknown `blockType` → log and render nothing (guarded by `tests/int/blocks.int.spec.ts`).

---

## 9. Theming — Design Tokens & CSS

Per-site tokens from `theme` collection (`isGlobal: true`). Public read via `GET /api/theme` (Host-scoped) or `GET /api/site` (embedded `theme`).

### Token Shape
```ts
type Theme = {
  primary?: string | null    // hex "#rrggbb" or "#rgb"
  accent?: string | null
  background?: string | null // light palette — scoped away from dark
  foreground?: string | null
  radius?: "none"|"sm"|"md"|"lg"|null
  lineHeight?: number|null    // 1.4..2.4, default 1.8
}
```

### How Tokens Become CSS
`src/lib/theme.ts` → `themeCss(theme: Theme|null): string`

```ts
import { themeCss } from '@eshobe/site-runtime/theme' // or '@/lib/theme'
// In <head>:
<style dangerouslySetInnerHTML={{ __html: themeCss(site.theme) }} />
```

Output:
```css
body{--primary:#0f766e;--primary-foreground:oklch(...);--accent:#f59e0b;--accent-foreground:...;--radius:0.625rem;--line-height:1.8;}
html:not([data-theme='dark']) body{--background:#ffffff;--foreground:#0a0a0a;}
```
- Colors validated `isHexColor` — non-hex dropped (no injection: stray `}` would rewrite page CSS).
- `readableOn(hex)` computes WCAG luminance threshold (0.179) → picks black/white foreground for brand colors.
- Tailwind v4's `@theme inline` maps `var(--primary)` → `bg-primary`, `text-primary`, `border-primary`, `ring-primary`, etc.

Tailwind config: all logical utilities only. Never use `ml-*`, `pl-*`, `text-left` — `eslint.config.mjs` bans them. Use `ms-*`, `ps-*`, `text-start/end`. `rtl:`/`ltr:` variants only where direction genuinely differs.

**Global CSS tokens** you can rely on (from `globals.css` `@theme`):

```
--primary, --primary-foreground
--accent, --accent-foreground
--background / --foreground
--card, --card-foreground
--muted, --muted-foreground
--border, --input, --ring
--radius, --radius-sm|md|lg|xl
--line-height
```

Emit `themeCss` on `body` scope — no rebuild when editor saves.

### Applying in a Headless Theme

```tsx
// layout.tsx
const site = await fetchSite() // GET /api/site with Host
return (
  <html lang={locale} dir={dirFor(locale)}>
    <head><style>{themeCss(site.theme)}</style></head>
    <body className="bg-background text-foreground leading-[var(--line-height)]">
      {children}
    </body>
  </html>
)
```

Or vanilla HTML:
```html
<script type="module">
  import { themeCss } from 'https://cms.example.com/site-runtime/theme.js'
  const site = await fetch('/api/site').then(r=>r.json())
  document.head.appendChild(Object.assign(document.createElement('style'), {textContent: themeCss(site.theme)}))
</script>
```

---

## 10. Internationalization, Dates, Numbers & Money

### Locales
```ts
locales = [{code:'fa', label:'فارسی', rtl:true}, {code:'en', label:'English', rtl:false}]
defaultLocale = 'fa'
isLocale(code) → boolean
dirFor(code) → 'rtl'|'ltr'
localeHref(path, locale, siteDefault) → "/fa/about" or "/about" (when locale === default, no prefix)
```

### Every Render Rule (enforced)
```ts
import { formatDate, formatNumber, formatPrice, toLocaleDigits } from '@eshobe/site-runtime'
import { slugify } from '@eshobe/site-runtime/slug'

// Date — Shamsi on fa, Gregorian on en, fixed timezone Asia/Tehran
formatDate(post.publishedAt, locale) // "۱۲ اردیبهشت ۱۴۰۳" vs "May 2, 2024"
formatDate(date, locale, { dateStyle:'long' }) // default

// Number — Persian-Indic digits on fa
formatNumber(1234, locale) // "۱٬۲۳۴" on fa, "1,234" on en
formatNumber(0.5, locale, { style:'percent' })

// Phone / postal (leading zero) — don't use formatNumber (eats leading zero)
toLocaleDigits("09121234567", locale) // "۰۹۱۲۱۲۳۴۵۶۷" on fa

// Price — integer minor → localized with unit word
formatPrice(product.price, site.store.currency, locale) // "۱۸۰٬۰۰۰ تومان"
formatPrice(product.price, "USD", "en") // "1,800.00 $"
```

### Money Module

```ts
import { currencies, currencyCodes, isCurrencyCode, parsePrice, majorToMinor, minorToMajor, tomanToRial, rialToToman } from '@eshobe/site-runtime/money'

currencies = {
  IRT: { code:'IRT', minorDigits:0, unit:{fa:'تومان', en:'Toman'} },
  IRR: { code:'IRR', minorDigits:0, unit:{fa:'ریال', en:'IRR'} },
  USD: { code:'USD', minorDigits:2, unit:{fa:'دلار', en:'$'} },
  EUR: { code:'EUR', minorDigits:2, unit:{fa:'یورو', en:'€'} },
}
// parsePrice("۱۲۳٬۴۵۶ تومان", "IRT") → 123456   | "12.50" with USD → 1250
// minorToMajor(120000, "IRT") → 120000         | minorToMajor(1250,"USD") → 12.5
// tomanToRial(100) → 1000                       | rialToToman(1000) → 100 (throws if %10!=0)
```

**Invariant:** product `price` is already minor. Don't `majorToMinor` it. Convert only when parsing human input or displaying with `minorToMajor` inside `formatPrice`. There's exactly one `*10` in `money.ts` — never in theme.

### Slugs (Persian-safe)
Payload's default slugify is ASCII (`[^\\w-]` → strips Persian → every title collides on `-`). This CMS uses:

```ts
slugify("درباره ما") // → "درباره-ما" (not "-")
slugify("صفحهٔ اصلی") // keeps hamza mark via \p{M}
pagePath("home") // → "/"   (HOME_SLUG = "home")
pagePath("درباره-ما") // → "/درباره-ما"
postPath("first-post") // → "/posts/first-post"
productPath("chair") // → "/products/chair"
```
RESERVED: `posts`, `search`, `checkout` cannot be page slugs (validated by hook `reservedPageSlug`).

---

## 11. Routing & URL Helpers

### Host → Domain Rewriting
`src/proxy.ts` rewrites every request on a customer Host to `/<host><path>`:

```
https://acme.ir/en/about  →  /acme.ir/en/about   (inside Next)
Header: x-locale = "en" (first path segment if isLocale)
```

Root layout reads `headers().get('host')` → site → `getSiteContext().locale/dir/site/serving`.

### Locale Prefix
- Site's `defaultLocale` has **no prefix**: `https://acme.ir/` not `/fa/`
- Other locales do: `https://acme.ir/en/about`
- Unknown/ unserved locale → `404` (don't fall back to default silently — that duplicates home page under `/de`).

### `resolveSiteRoute(path[])` — pure, testable
```ts
import { resolveSiteRoute } from '@eshobe/site-runtime/slug'
resolveSiteRoute([])                    // {kind:"page", slug:"home"}
resolveSiteRoute(["درباره-ما"])         // {kind:"page", slug:"درباره-ما"}
resolveSiteRoute(["en","about"])        // {kind:"page", slug:"about"} (locale stripped)
resolveSiteRoute(["posts"])             // {kind:"posts"}
resolveSiteRoute(["en","posts"])        // {kind:"posts"}
resolveSiteRoute(["posts","first"])     // {kind:"post", slug:"first"}
resolveSiteRoute(["products","chair"])  // {kind:"product", slug:"chair"}
resolveSiteRoute(["search"])            // {kind:"search"}
resolveSiteRoute(["checkout","<uuid>"]) // {kind:"checkout", order:"<uuid>"|null}
```

Site's `generateMetadata` and body both call this — keep them in sync.

### Building URLs
```ts
import { sitePath, siteUrl, siteOrigin, pagePath, postPath, productPath } from '@eshobe/site-runtime/slug' // or '@/lib/site-url'
import { localeHref } from '@eshobe/site-runtime'

localeHref("/about", "en", "fa") // "/en/about"
localeHref("/", "fa", "fa")      // "/"  (default = no prefix)
sitePath(site, locale, slug, base) // locale-aware, e.g., sitePath(site,"en","hello", "/posts") → "/en/posts/hello"
siteUrl(site, {locale, slug, base}) // absolute: "https://acme.ir/en/posts/hello"
siteOrigin(site, reqOrigin) // "https://acme.ir" (preserves protocol/port from request)
revalidationPaths({domain, locale, siteDefaultLocale, slug, base}) // ["/acme.ir/en/posts/hello", "/acme.ir/posts/hello"] for default
```

**Use these helpers for every link, canonical, sitemap entry, OG.** `link.href` from rich text should go through `CMSLink` which does; don't hand-build `/${slug}` (you'll get `/home` for home).

### Next.js Site Handler (`src/app/(site)/[domain]/[[...path]]/page.tsx`)
Switch on `route.kind`:

```ts
switch(resolveSiteRoute(path).kind){
  case 'page':     return <SitePage slug={route.slug}/>
  case 'post':     return <PostDetail slug={route.slug}/>
  case 'posts':    return <PostsIndex page={pageNumber(q.page)}/>
  case 'product':  return <ProductDetail slug={route.slug}/>
  case 'search':   return <SearchResults q={q.q} />
  case 'checkout': return <CheckoutReceipt order={route.order} receipt={q.r} />
}
// all guarded by: if (!(await localeIsServed(path))) notFound()
// and: if (site && !serving) return <SiteHolding/>
```

Recreate headlessly by mirroring that switch — same locale guard, same `resolveSiteRoute`, same serving check.

---

## 12. Media

Uploads are tenant-namespaced (`sites/<siteId>/media/<filename>` via `setMediaPrefix` hook, stored in ArvanCloud Object Storage in prod, `public/media` in dev).

REST:
```bash
GET /api/media?limit=20&locale=fa&where[site][equals]=<id>  # but scoped by Host anyway
GET /api/media/<id>?locale=fa
GET /api/media/file/<filename>   # streaming route, Caddy carve-out — needs Host
```

**Rendering:**
Only `url` (and `sizes.*.url`) are returned relative in dev (`/api/media/file/x.png`). Build absolute:

```ts
const origin = site.media.origin // "https://acme.ir"
const url = new URL(media.url!, origin).toString()
// For size:
const thumb = media.sizes?.thumbnail?.url ? new URL(media.sizes.thumbnail.url, origin).toString() : url
```

`media.url` stays relative in every environment: the object-storage bucket is private and files
are always streamed through the CMS proxy (`/api/media/file/*`), so `new URL(url, origin)` is
always how a renderer builds the absolute URL.

Caddy carve-out: `/api/media/file/*` is allowed on customer domains (others 404).

---

## 13. SEO, Sitemap, Robots, OG

All per-site (`[domain]` segment). Never generate one-file-per-platform.

### `generateMeta` (pages/posts)
```ts
import { generateMeta } from '@/utilities/generateMeta'
const meta = await generateMeta({ doc: page, base }) // page or post
// returns { title, description, openGraph:{ images:[{url: "/og?slug=...&locale=fa"}] }, alternates:{canonical}, ... }
```
Uses `siteUrl(site, {locale, slug, base})` internally — canonical is Host-aware.

### `GET /sitemap.xml` (per domain)
`src/app/(site)/[domain]/sitemap.xml/route.ts` enumerates:
- pages (per `availableLocales`, `fallbackLocale:false` so untranslated locales don't get a URL that 404s)
- posts (same)
- per-locale `hreflang` with canonical pointing to that locale's variant

Headlessly, replicate with:
```ts
GET /api/pages?where[_status][equals]=published&limit=1000&locale=fa&fallbackLocale=false&select[slug]=true&sort=-updatedAt
// then for each slug: siteUrl(site,{locale, slug}) for <url><loc>
```

### `GET /robots.txt` (per domain)
```
Sitemap: https://acme.ir/sitemap.xml
# or Disallow: / for suspended/archived/unknown host
```
Route: `src/app/(site)/[domain]/robots.txt/route.ts`.

### `GET /og?slug=<slug>&locale=<locale>` — OG image
- Validates `locale` is served, `slug` belongs to this site.
- Vendored Vazirmatn WOFF (arabic + latin at 400/700, separate family names, satori).
- Renders title + site.name/domain, RTL-aware (LTR wrapper + `direction: rtl` on text node).
- Cache: `public, s-maxage=86400`, immutable per `?v=updatedAt` added by `generateMeta`.

Usage in theme head:
```html
<meta property="og:image" content="https://acme.ir/og?slug=درباره-ما&locale=fa" />
```

### Canonical / Hreflang Rules
- Home slug `home` → canonical `/` (not `/home`).
- Default locale has **two revalidation paths** (`/acme.ir/slug` + `/acme.ir/fa/slug`) but one canonical (without prefix).
- `alternates()` from `src/lib/alternates.ts` produces per-locale alternates for `<link rel="alternate" hreflang="x">`.

---

## 14. Security & Multi-Tenancy

**The one rule:** tenant comes from the socket (Host) or a credential (site API key), never from a parameter.

| Vector | Guard |
|--------|------|
| Anonymous REST tries `where[site][equals]=OTHER` | ANDed with `siteConstraint` → empty (`siteRead.ts`) |
| Crafted `POST /api/checkout` body with `site:OTHER` | Ignored — `siteFromRequest(req)` is authoritative, and `overrideAccess:true` create uses that id |
| `POST /api/form-submissions` with `site:OTHER` | `beforeValidate` derives site from `form.site` |
| Draft exfiltration via `GET /api/pages?draft=true` | `scopedPublishedRead` returns `{_status:published}` constraint for anonymous; logged-in narrowed to own sites |
| Object-storage media of another site | Key prefix `sites/<id>/media/`; serving route checks site scope |
| Customer reads another's theme/store | `scopedPublicRead` with Host — one theme/store per Host |

**Fail-closed behavior:** when an HTTP request's `Host` resolves to no site (control plane `cms.example.com` or an unknown domain) and it has neither a Payload session nor a site API key, public collection access returns `false`; production Caddy also denies anonymous public REST/GraphQL reads on the control-plane vhost before they reach Node. Non-HTTP Local API calls (seed, jobs, hooks and `findForSite`) remain exempt because they carry no `Host` and already name their tenant in the query. For a theme, always fetch with a tenant Host or a site key — never rely on an unscoped fallback.

### Publishing Gate
No `publish` permission. `writeUnlessPublishing({collection})` returns `false` when `data._status==='published'` and caller is not `owner|platformAdmin` → Publish button hidden, REST publish rejected. Editor role may draft, not publish.

### Slugs
Unique per `{site, locale}` via `uniqueSlugPerSite` hook (not DB index). Reserved words (`posts, search, checkout`) rejected via `reservedPageSlug`. Add new site routes to `RESERVED_PAGE_SLUGS` — forgetting makes the page shadowed with no error.

---

## 15. Rendering a Theme — Complete Example

Minimal headless ecommerce theme (Next 14+/React 19, no Payload import, fetches over REST + Host).

### `lib/cms.ts` — bootstrap + fetches

```ts
export type SiteDescriptor = /* from GET /api/site */
export async function getSite(domain:string){
  // In Next server component, set Host via headers forwarded by proxy.
  // In external renderer, pass Host explicitly:
  const res = await fetch(`${process.env.CMS_ORIGIN}/api/site`, {
    headers: { Host: domain },
    next: { revalidate: 30 } // matches cache-control
  })
  if(!res.ok) throw new Error('unknown host')
  return res.json() as Promise<SiteDescriptor>
}

export async function getPage(domain:string, slug:string, locale:string){
  const url = `${process.env.CMS_ORIGIN}/api/pages?where[slug][equals]=${encodeURIComponent(slug)}&locale=${locale}&depth=1&limit=1`
  const res = await fetch(url, { headers:{ Host: domain } , next:{revalidate:60}})
  const json = await res.json()
  return json.docs[0] ?? null
}

export async function getProductBySlug(domain:string, slug:string, locale:string){
  const url = `${process.env.CMS_ORIGIN}/api/products?where[slug][equals]=${encodeURIComponent(slug)}&locale=${locale}&depth=1&limit=1`
  const res = await fetch(url, { headers:{ Host: domain }})
  return (await res.json()).docs[0] ?? null
}

export async function listProducts(domain:string, locale:string, limit=12){
  const res = await fetch(`${process.env.CMS_ORIGIN}/api/products?limit=${limit}&sort=-createdAt&locale=${locale}&depth=1`, { headers:{ Host: domain }})
  return res.json()
}
```

### `app/[domain]/[[...path]]/page.tsx` — router

```tsx
import { resolveSiteRoute } from '@eshobe/site-runtime/slug'
import { dirFor, localeCodes } from '@/lib/locales' // or site-runtime
import { formatPrice, formatDate } from '@eshobe/site-runtime'

export default async function Page({ params}:{ params:{domain:string, path?:string[]}}){
  const site = await getSite(params.domain)
  const path = params.path ?? []
  const localeSeg = path[0]
  const locale = localeCodes.includes(localeSeg) ? localeSeg : site.defaultLocale
  if (localeSeg && !site.availableLocales.includes(localeSeg)) notFound()
  if (site.status !== 'active') return <Holding site={site}/>

  const route = resolveSiteRoute(path)
  if (route.kind === 'product') {
    const product = await getProductBySlug(site.domain, route.slug, locale)
    if (!product) notFound()
    return <ProductDetail product={product} site={site} locale={locale}/>
  }
  if (route.kind === 'posts') { /* fetch posts */ }
  // ...
  const slug = route.kind==='page' ? route.slug : 'home'
  const page = await getPage(site.domain, slug, locale)
  if (!page) notFound()
  return <RenderBlocks layout={page.layout} site={site} locale={locale}/>
}

function RenderBlocks({layout, site, locale}:{layout:any[], site:any, locale:string}){
  return layout.map((block:any)=>{
    switch(block.blockType){
      case 'productGrid': return <ProductGridBlock key={block.id} block={block} site={site} locale={locale}/>
      case 'content': return <ContentBlock block={block}/>
      // ... other 12
      default: console.warn('unknown block', block.blockType); return null
    }
  })
}
```

### `components/ProductGridBlock.tsx` — ecommerce block

```tsx
'use client'
import { formatPrice, toLocaleDigits } from '@eshobe/site-runtime'
import { useState } from 'react'

export function ProductGridBlock({ block, site, locale }:any){
  // In server component, fetch here and pass down — simplified here with client fetch
  const [products, setProducts] = useState(/* fetched server-side */)
  return (
    <section>
      {block.heading && <h2>{block.heading}</h2>}
      <div className={`grid grid-cols-1 sm:grid-cols-${block.columns ?? 3} gap-6`}>
        {products.docs.map((p:any)=>(
          <div key={p.id} className="border rounded-lg p-4">
            {p.image?.url && <img src={new URL(p.image.url, site.media.origin).toString()} alt={p.image.alt ?? p.title} />}
            <h3>{p.title}</h3>
            {p.summary && <p>{p.summary}</p>}
            <div className="font-bold">{formatPrice(p.price, site.store.currency, locale)}</div>
            {p.compareAtPrice && <div className="line-through opacity-60">{formatPrice(p.compareAtPrice, site.store.currency, locale)}</div>}
            {block.showBuyButton && <PurchaseForm productId={p.id} siteDomain={site.domain} locale={locale}/>}
          </div>
        ))}
      </div>
    </section>
  )
}

function PurchaseForm({productId, siteDomain, locale}:any){
  const [loading,setLoading]=useState(false)
  async function submit(formData:FormData){
    setLoading(true)
    const res = await fetch(`https://${siteDomain}/api/checkout`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({
        product: productId,
        quantity: Number(formData.get('quantity')||1),
        name: String(formData.get('name')||''),
        phone: String(formData.get('phone')||''),
        email: String(formData.get('email')||''),
        note: String(formData.get('note')||''),
        company: String(formData.get('company')||'') // honeypot hidden input
      })
    })
    const json = await res.json().catch(()=>null)
    setLoading(false)
    if(res.status===429){ alert('چند لحظه صبر کنید'); return }
    if(!res.ok && !json?.ok){ alert(json?.message ?? 'خطا') ; return }
    window.location.href = json.redirectUrl || json.confirmationUrl
  }
  return (
    <form action={submit} className="mt-3 space-y-2">
      <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true"/>
      <input name="name" required placeholder="نام" className="border ps-3 pe-3 py-2 w-full"/>
      <input name="phone" required placeholder="۰۹۱۲..." dir="ltr" className="border ps-3 pe-3 py-2 w-full"/>
      <input name="quantity" type="number" min={1} max={10} defaultValue={1} className="border w-20"/>
      <button disabled={loading} className="bg-primary text-primary-foreground px-4 py-2 rounded-md w-full">خرید</button>
    </form>
  )
}
```

### `layout.tsx` — theme + dir + font

```tsx
import { themeCss } from '@eshobe/site-runtime/theme'
import { dirFor } from '@/lib/locales'
import { Vazirmatn } from 'next/font/google'

const vazir = Vazirmatn({ subsets:['arabic','latin'], weight:['400','700'], display:'swap' })

export default async function Layout({children, params}:{children:any, params:any}){
  const site = await getSite(params.domain)
  const locale = params.path?.[0] // resolved same as page
  const active = site.availableLocales.includes(locale) ? locale : site.defaultLocale
  return (
    <html lang={active} dir={dirFor(active)} className={vazir.className}>
      <head><style dangerouslySetInnerHTML={{__html: themeCss(site.theme)}}/></head>
      <body className="bg-background text-foreground leading-[var(--line-height)] antialiased">{children}</body>
    </html>
  )
}
```

**That's your ecommerce theme skeleton.** Add the other 13 blocks, header/footer fetches, search input → `GET /api/search?where[title][like]=q`, and canonical/meta via `siteUrl`.

---

## 16. Headless Checklist & Build Order for an AI Agent

When prompted to *build a theme*, have the AI run this sequence — don't skip steps:

1. **Fetch `GET /api/site`** — store `availableLocales`, `defaultLocale`, `blocks`, `store.currency`, `theme`, `media.origin`, `contractVersion`. If `type !== "store"` and block list lacks `productGrid`, the price block is `pricing` instead — adapt.
2. **Probe a product** — `GET /api/products?limit=1&locale=<default>` → learn currency formatting, inventory shape, image URL shape.
3. **Pick router** — implement `resolveSiteRoute` + `localeHref` + `dirFor`. Handle `RESERVED_PAGE_SLUGS` and serving guard. Test: `/`, `/en`, `/posts`, `/posts/<slug>`, `/products/<slug>`, `/search`, `/checkout/<id>`.
4. **Implement blocks** — start with `productGrid` + `content` + `mediaBlock` + `cta`. Others are incremental. Assert unknown `blockType` warns, not crash.
5. **Theme** — `themeCss(site.theme)` in `<style>`, Vazirmatn, logical Tailwind utilities, body `line-height: --line-height`.
6. **Formatting** — replace every `date.toLocaleString()` with `formatDate(date, locale)`, every `num.toString()` with `formatNumber`/`toLocaleDigits`, every price with `formatPrice(minor, currency, locale)`.
7. **Checkout UI** — product card with honeypot (`company` hidden), `POST /api/checkout`, handle 429/409/missing price, redirect to `redirectUrl ?? confirmationUrl`.
8. **Media** — `new URL(media.url, site.media.origin)`. Prefer `sizes.medium` for grid.
9. **SEO** — canonical via `siteUrl`, `hreflang` from alternates, OG via `/og`, `noindex` on `/search` and `/checkout`.
10. **Revalidation** — if timer-based, `fetch` with `next: {revalidate:30}`. If event-driven, listen to `POST REVALIDATE_WEBHOOK_URL` with `x-eshobe-signature` HMAC verification (see §17).

**Prompt to give the agent:**

> Build a Persian-first ecommerce theme for Eshobe CMS. Use only Host-scoped public APIs; tenant is the Host, never a param. First fetch `/api/site` for the tenant's locales, blocks, currency and theme tokens, render them through `@eshobe/site-runtime` helpers. The store sells with `GET /api/products` (price is integer minor units in site.store.currency — format only via formatPrice), buy via `POST /api/checkout` (with honeypot field `company`), and receipt at `/checkout/:id?r=`. Block `productGrid` is the catalogue; other 13 blocks are static. Theme tokens go via themeCss() as body CSS variables; all dates Jalali on fa via formatDate. Never invent a currency conversion — site owns the unit.

---

## 17. Errors, Rate Limits & Webhooks

### Errors
Payload REST errors are JSON `{ message, errors?: PayloadValidationError[] }` with appropriate HTTP status. Common:

- `400` — `product id missing or malformed`, `quantity out of range`, `buyer details missing or invalid` (checkout validation), or Payload `ValidationError` (`errors: [{field, message}]` field-level Persian messages).
- `403` — needs platform key / platformAdmin (provision-site, api-keys).
- `404` — `unknown-host`, missing page/post/product, or slug not found in this site+locale.
- `409` — inventory `"این محصول تمام شده"` or duplicate order.
- `429` — checkout throttled, `retry-after` seconds.
- `503` — PSP initiate failed, order stays pending → show `confirmationUrl`.

### Rate Limits
- Checkout per `site+IP` fixed window — default `20 / 10min` (`CHECKOUT_RATE_LIMIT`, `CHECKOUT_RATE_LIMIT_WINDOW_MS`). Returns `429` + `retry-after`.
- Duplicate per `site+phone+product` — 15min window (`CHECKOUT_DUPLICATE_WINDOW_MINUTES`). Returns `409` without receipt link (anti-oracle).

### Webhooks

#### Renderer Revalidation — `POST ${REVALIDATE_WEBHOOK_URL}`
Payload fires on every `afterChange` (pages/posts/etc.) via `src/hooks/revalidateSiteDoc.ts` → `notifyRenderers`.
```http
POST https://your-renderer.example.com/revalidate
x-eshobe-signature: sha256=<hex HMAC-SHA256(PAYLOAD_SECRET, rawBody)>
x-eshobe-timestamp: 2024-05-17T10:00:00Z
content-type: application/json

{ "paths": ["/acme.ir/en/pricing", "/acme.ir/pricing"], "tags":["site:...:page"], "resources":["page"], "siteId":"...", "timestamp":"2024-05-17T10:00:00Z" }
```
Verify the HMAC over the **raw body bytes only** with `PAYLOAD_SECRET` (a deployed theme: its `ESHOBE_REVALIDATE_SECRET`, §17b); then purge cache / revalidate path. `resources` and `tags` are additive semantic hints for page/post/listing/category/navigation/branding/theme-setting invalidation; v1 receivers may continue reading only `paths`. `x-eshobe-timestamp` is informational and is **not** part of the v1 signature — do not prepend it when verifying. (The platform webhooks in `docs/platform-control-api.md` sign `<timestamp>.<body>`; this one does not, and a timestamped renderer signature would be a v2 contract.) Best-effort, 3s timeout, at-most-once — if you need at-least-once, consume jobs queue instead.

#### Domain-check (Caddy)
`GET /api/domain-check?domain=<host>` → `200 {authorised:true}` if site active+verified else `404`. Caddy's `on_demand_tls { ask http://web:3000/api/domain-check }` gates TLS issuance (prevents CA rate-limit burn). Not theme-related but required for custom domains.

#### Jobs Queue (scheduled publish)
`versions.drafts.schedulePublish` queues `schedulePublish` job with `waitUntil`. Web container's `getPayload({cron:true})` + `jobs.autoRun: "* * * * *"` runs it (VPS only — never serverless, duplicates on multi-replica). For themes: draft pages appear when job fires; webhook above notifies.

---

## 17b. Deployable Themes and `eshobe.theme.json`

A deployable Theme is one `theme-packages` row in the CMS. The UI calls it **Theme / پوسته**;
the internal slug remains `theme-packages` for database/API compatibility. A Theme owns the
GitHub source, manifest, design defaults, build/registry contract, runtime schemas and the
versions/artifacts built from it. It does **not** own a live site's custom design tokens:
`theme-packages.designDefaults` is copied into the site's `theme` document only when the site
first adopts a different Theme after a successful production health check, or when an operator
explicitly chooses **Apply theme defaults**.

### Three connection patterns

#### A. Same-domain production renderer

```text
https://shop.example.com
```

The browser calls CMS-owned paths on the same origin:

```text
/api/site
/api/pages
/api/posts
/api/products
/api/checkout
/api/payments/methods
/api/media/file/*
```

In legacy `edge` mode, Caddy keeps `/api/*` on the CMS and proxies page traffic to the theme.
In Coolify-first `direct` mode the customer DNS points at the theme container, so the theme
must proxy the CMS-owned `/api/*` paths back to `ESHOBE_CMS_URL` and preserve the original
`Host` header. That promise is the manifest flag `proxiesApi: true`; production `direct`
deploys are refused without it. Theme-owned routes such as HTML pages, assets, `/api/health`,
and `/api/revalidate` stay in the theme app.

#### B. Server-side CMS access with a Site API Key

A managed deployment receives these platform variables (the theme cannot override them):

```text
ESHOBE_CMS_URL
ESHOBE_API_KEY
ESHOBE_SITE_ID
ESHOBE_SITE_DOMAIN
ESHOBE_DEFAULT_LOCALE
ESHOBE_LOCALES
ESHOBE_SITE_TYPE
ESHOBE_CURRENCY
ESHOBE_PUBLIC_ORIGIN
ESHOBE_REVALIDATE_SECRET
ESHOBE_CONTRACT_VERSION
```

Server code may call:

```http
GET ${ESHOBE_CMS_URL}/api/site
Authorization: Bearer ${ESHOBE_API_KEY}
```

Tenant identity comes from **Host** or from **`Authorization: Bearer <site key>`**. It never
comes from `?site=`, a public body `siteId`, or a tenant query parameter. Public host-resolved
`GET /api/site` never returns internal package IDs, Coolify UUIDs, server UUIDs, deployment
secrets, registry credentials, site API keys, revalidation secrets, tenant secret values or
ciphertext.

#### C. Preview deployment

A preview has its own Theme Binding and Coolify application, usually on a wildcard hostname
such as:

```text
https://<site>-<theme>-preview.sites.example.com
```

Preview uses CMS credentials injected by the platform, but `ESHOBE_PUBLIC_ORIGIN` is the
preview origin, not the canonical site domain. Preview never changes production routing,
`sites.renderedBy`, `sites.activeDeployment`, or the live site's design tokens. A failed
preview is only a failed deployment row.

### Public and private GitHub repositories

Public repositories are read via `raw.githubusercontent.com` without private credentials.
Private repositories use the platform's `GITHUB_THEME_TOKEN` integration. Tokens stay in the
CMS/Coolify control plane; they are never exposed to tenants, theme containers, manifests,
logs or deployment history. Repository names are parsed as GitHub `owner/name` only, and refs
are validated before they are used.

### Manifest location and parser

Commit `eshobe.theme.json` at the repository root. The CMS reads it during manual sync and
GitHub push webhook sync. Sync validates strictly; on failure it records `syncError` and keeps
the previous valid manifest, commit and design defaults. A webhook sync only marks update
availability — it never auto-deploys production.

Complete example using the current field names:

```json
{
  "contractVersion": 1,
  "key": "graphite",
  "name": "Graphite",
  "nameFa": "گرافیت",
  "siteTypes": ["business", "portfolio", "store"],
  "locales": ["fa", "en"],
  "previewUrl": "https://example.com",
  "proxiesApi": true,
  "capabilities": { "commerce": true },
  "design": {
    "primary": "#0f766e",
    "accent": "#f59e0b",
    "background": "#ffffff",
    "foreground": "#0a0a0a",
    "radius": "md",
    "lineHeight": 1.8
  },
  "deployment": {
    "strategy": "registry_image",
    "registryProvider": "ghcr",
    "registryImageRepository": "ghcr.io/owner/theme",
    "registryVisibility": "public"
  },
  "build": {
    "buildPack": "dockerfile",
    "baseDirectory": "/",
    "dockerfileLocation": "Dockerfile",
    "installCommand": null,
    "buildCommand": null,
    "startCommand": null,
    "publishDirectory": null,
    "port": 3000,
    "healthCheckPath": "/api/health",
    "isStatic": false
  },
  "env": [
    {
      "key": "EXAMPLE_API_KEY",
      "source": "tenant",
      "required": false,
      "secret": true,
      "labelFa": "کلید API",
      "help": "Value is encrypted and injected only at deploy time."
    }
  ],
  "settings": {
    "showSectionNumbers": {
      "type": "boolean",
      "default": true,
      "labelFa": "نمایش شماره بخش‌ها"
    }
  },
  "contentSlots": [
    {
      "key": "home",
      "type": "page",
      "required": true,
      "labelFa": "صفحه اصلی"
    }
  ]
}
```

### Manifest fields

| Field | Type | Required | Default | Allowed values / validation | Security meaning and runtime effect |
|---|---|---:|---|---|---|
| `contractVersion` | integer | yes | — | `>=1` and `<=` platform `contractVersion` | Refuses themes written for a newer public renderer contract. Optional fields such as `design` do **not** bump v1. |
| `key` | string | no | slugified `name` | ASCII slug produced by the parser | Public theme identity (`themeRuntime.theme.key`). Use a stable explicit key; changing it creates a new identity. |
| `name` | string | yes | — | non-empty | Operator/customer display name. |
| `nameFa` | string/null | no | `null` | non-empty string if present | Persian display name. |
| `siteTypes` | array | no | `business`, `portfolio`, `store` | only `business`, `portfolio`, `store`; non-empty if supplied | Deploy-time compatibility. The package row may narrow this further. |
| `locales` | string[] | no | `["fa"]` | non-empty strings | Theme UI locale support metadata. The site still decides its served locales. |
| `previewUrl` | string/null | no | `null` | HTTPS only | Catalogue/demo link. Parser also accepts legacy `preview`. |
| `proxiesApi` | boolean | no | `false` | boolean only | Required for Coolify-first direct production because `/api/*` hits the theme container. |
| `capabilities` | object | no | `{}` | `Record<string, boolean>`; non-true values become `false` | Metadata for filtering/reporting; not an execution surface. |
| `design` | object | no | `{}` | keys exactly `primary`, `accent`, `background`, `foreground`, `radius`, `lineHeight` | Optional design defaults copied on adoption/reset only. Unknown keys reject the manifest. |
| `deployment` | object | no | omitted | see below; unknown deployment keys reject | GHCR/registry strategy synced into the theme package on manifest sync. |
| `build` | object | no | `{}` | see below; unknown build keys reject | Instructions projected to Coolify. Treat as untrusted repository input. |
| `env` | array | no | `[]` | max 50 entries; see below | Deployment environment declarations. Values are never taken from the manifest. |
| `settings` | object | no | `{}` | max 50 entries; see below | Safe runtime presentation settings returned through `GET /api/site`; no rebuild needed. |
| `contentSlots` | array | no | `[]` | max 50 entries; see below | Tenant-scoped content binding schema. |

#### `design`

| Key | Type | Required | Default | Allowed values | Runtime effect |
|---|---|---:|---|---|---|
| `primary`, `accent`, `background`, `foreground` | string | no | omitted | hex color accepted by the site theme schema (`#rgb` or `#rrggbb`) | Copied into `theme` only on first successful different-theme production adoption or explicit reset. |
| `radius` | string | no | omitted | `none`, `sm`, `md`, `lg` | Same as site `theme.radius`. |
| `lineHeight` | number | no | omitted | `1.4` through `2.4` | Same as site `theme.lineHeight`. |

Changing `design` in GitHub and syncing the Theme does not repaint existing sites.

#### `build`

Current build packs are exactly:

```text
nixpacks
dockerfile
static
dockercompose
```

| Key | Type | Required | Default | Validation / effect |
|---|---|---:|---|---|
| `buildPack` | string | no | `nixpacks` | One of the build packs above. Legacy `pack` is accepted for old manifests. |
| `baseDirectory` | string | no | `/` | Safe path only, no `..`; must start with `/`. |
| `dockerfileLocation` | string/null | no | `null` | Optional safe path for `dockerfile`; <= 500 chars, no control characters or `..`. |
| `installCommand` | string/null | no | `null` | Passed to Coolify only after validation: a single package-manager/framework command (`pnpm`, `npm`, `yarn`, `bun`, `node`, `npx`, `next`, `vite`, `astro`, `nuxt`, `remix`, `gatsby`, `serve`) with simple arguments. Shell operators, quotes, pipes, redirects and control characters are rejected. |
| `buildCommand` | string/null | no | `null` | Same. `null` means let the build pack decide. |
| `startCommand` | string/null | no | `null` | Same. |
| `publishDirectory` | string/null | no | `null` | Static output directory; safe path only. |
| `port` | number/string | no | `3000` | Integer 1–65535. |
| `healthCheckPath` | string/null | no | `null` | Safe path; must start with `/` when present. Coolify's container health check curls it from inside the container against `127.0.0.1:<port>` — IPv4 loopback on purpose (`localhost` resolves to `::1` on IPv6-first images and the check refuses to connect), so the server must answer on IPv4. |
| `isStatic` | boolean | no | `true` only when `buildPack`/legacy `pack` is `static`, else `false` | Coolify static flag. |

Unknown build keys (for example `build.command`) are rejected instead of ignored because they
are execution-adjacent input from an untrusted repository.

#### `deployment`

Optional. When present, manifest sync copies these fields onto the theme package row so
preview/production use immutable GHCR digests instead of Coolify source builds.

| Key | Type | Required | Validation |
|---|---|---:|---|
| `strategy` | string | yes | `coolify_build` or `registry_image` |
| `registryProvider` | string | yes when `strategy` is `registry_image` | `ghcr` |
| `registryImageRepository` | string | yes when `strategy` is `registry_image` | `ghcr.io/owner/image` |
| `registryVisibility` | string | no | `public` (default) or `private` |

#### `env`

Each entry declares one environment variable shape:

| Key | Type | Required | Default | Meaning |
|---|---|---:|---|---|
| `key` | string | yes | — | `/^[A-Z][A-Z0-9_]{0,63}$/`; duplicates rejected. |
| `source` | `platform`/`tenant` | no | `tenant` | Who supplies the value. |
| `required` | boolean | no | `false` | Required tenant value before deploy. |
| `secret` | boolean | no | `false` | Tenant value is encrypted and write-only. |
| `labelFa` | string/null | no | `null` | Persian form label. |
| `help` | string/null | no | `null` | Help text. |

`platform` values are controlled by CMS. `tenant` values are supplied through **Site → Theme
Settings** and validated against the manifest. A theme cannot make a protected platform key a
tenant question. Current protected `PLATFORM_ENV_KEYS` are:

```text
ESHOBE_CMS_URL
ESHOBE_SITE_DOMAIN
ESHOBE_SITE_ID
ESHOBE_API_KEY
ESHOBE_DEFAULT_LOCALE
ESHOBE_LOCALES
ESHOBE_SITE_TYPE
ESHOBE_CURRENCY
ESHOBE_REVALIDATE_SECRET
ESHOBE_CONTRACT_VERSION
ESHOBE_PUBLIC_ORIGIN
```

Secret lifecycle:

```text
Theme declares requirement
→ customer enters value in Site Theme Settings
→ CMS encrypts value at rest
→ deploy job decrypts only while creating/updating the Coolify environment
→ secret is never returned by API, admin reads, logs, deployment history or errors
```

Tenant values are limited to 2048 characters. Platform values are written **after** tenant
values in the Coolify environment so protected keys cannot be shadowed even if a future bug
relaxes validation.

#### Runtime `settings`

Runtime settings are not environment variables. They are safe presentation/runtime choices that
can change without rebuilding the container and are returned under `GET /api/site` →
`themeRuntime.settings` after validation.

`settings` is an object whose keys match `/^[a-z][A-Za-z0-9]{0,63}$/`. Each value supports:

| Key | Type | Required | Meaning |
|---|---|---:|---|
| `type` | string | yes | `boolean`, `text`, `number`, or `select`. |
| `default` | boolean/number/string | no | Must match `type`; for `select`, must be one of the option values. |
| `min`, `max` | number | no | Enforced for `number` values. |
| `options` | array | required for `select` | 1–50 options, each `{ value, labelFa?, labelEn? }`, value <= 100 chars. |
| `labelFa`, `labelEn` | string/null | no | Form labels. |
| `help` | string/null | no | Help text. |

Stored values are validated before save and again before returning through `/api/site`; unknown
or incorrectly typed settings are rejected.

Themes implement presentation behaviour (for example a home-page logo intro); the CMS only
declares the schema, validates tenant overrides, and exposes merged values on
`themeRuntime.settings`.

Example (Graphite home intro — animation logic lives in the theme repository):

```json
{
  "settings": {
    "introAnimation": {
      "type": "boolean",
      "default": true,
      "labelEn": "Home logo intro animation",
      "labelFa": "انیمیشن لوگوی صفحه اول"
    },
    "introDuration": {
      "type": "number",
      "default": 7000,
      "min": 0,
      "max": 20000,
      "labelEn": "Intro duration in milliseconds",
      "labelFa": "مدت انیمیشن به میلی‌ثانیه"
    }
  }
}
```

#### `contentSlots`

`contentSlots` is an array of content binding declarations. Supported types are exactly:

```text
page
post
category
form
media
```

Each slot has `{ key, type, required?, labelFa?, labelEn?, help? }`; `key` uses the same
`/^[a-z][A-Za-z0-9]{0,63}$/` pattern and cannot repeat.

Flow:

```text
Theme declares slot
→ Site owner chooses content in Site Theme Settings
→ CMS validates the selected document belongs to the same site
→ CMS stores the binding
→ GET /api/site returns a resolved binding
→ Theme renders it
```

Example response:

```json
{
  "themeRuntime": {
    "theme": { "key": "graphite" },
    "settings": { "showSectionNumbers": true },
    "bindings": {
      "home": { "id": "...", "type": "page", "slug": "home", "title": "خانه" }
    }
  }
}
```

Cross-tenant binding IDs are refused and unresolved/deleted targets return `null` for that slot.

##### How a theme should consume bindings

A binding is the **customer's choice of content**; the URL it appears at is **the theme's**.
Keep the two separate and a customer can call their About page anything.

1. **Routes are the theme's.** A theme that has an "About" section serves it at a fixed path of
   its own choosing (`/about`). Never derive that path from the bound document's slug — a
   Persian site's page is called `درباره-ما`, and nav, sitemap and canonical URLs would all
   move when somebody renames it.
2. **Look the document up by `id`, not by slug.** `bindings.<key>.id` is stable; the slug is
   editable and localized. Read it with the request's `locale` and `fallbackLocale=false`. A
   bound document that has no translation in that locale is *missing* there (404 or an empty
   state) — do not substitute a different page that happens to share a slug.
3. **Slug is only a first-run hint.** With no binding saved (a freshly provisioned site
   before anybody opened «تنظیمات پوسته»), a theme may look for a document whose slug equals
   its section key. The hint applies **only when the slot is unbound** (`null`/absent), never
   as a second opinion next to a binding.
4. **One canonical URL per bound page.** When a visitor reaches a bound page through its own
   slug (a rich-text link, an old bookmark), redirect to the section route. Internal
   references in CMS navigation carry the document `id`, so match on that.
5. **Resolve in one place.** Routes, navigation, sitemap and structured data must all go
   through the same lookup, or a menu item points at a page the route will not render.

The Graphite theme is the reference: `src/lib/theme/sections.ts` (rules, pure) and
`src/lib/cms.ts` (`getSectionPage`, `getHomePage`, `getSectionCategories`).

The operator console's **«آمادگی پوسته»** checklist (`GET …/deployment/readiness`) reports
required slots that are unbound, bound documents that are drafts or deleted, and bound pages
missing a served locale — the three ways a correct deploy still renders an empty page.

### Revalidation contract

When CMS content changes, the CMS sends a best-effort signed request to every live deployment's
application hostname:

```http
POST https://<application-host>/api/revalidate
content-type: application/json
x-eshobe-timestamp: 2026-09-28T10:00:00.000Z
x-eshobe-signature: sha256=<hex HMAC-SHA256(secret, rawBody)>

{"paths":["/acme.ir/fa/pricing"],"resources":["page"],"siteId":"...","tags":["site:...:page"],"timestamp":"2026-09-28T10:00:00.000Z"}
```

The secret is the deployment's `ESHOBE_REVALIDATE_SECRET`. Verify the signature over the exact
raw request body bytes only. Do **not** sign or verify `<timestamp>.<body>` for this v1
renderer contract; `x-eshobe-timestamp` is sent but not signed. A timestamp-signed scheme would
be a versioned v2 contract so existing themes do not silently reject every notice.

Delivery is at-most-once with a 3 second timeout. A failed receiver does not fail the CMS write.

### GHCR / immutable artifact flow

Registry-image Themes use immutable artifacts instead of mutable tags:

```text
GitHub repository
  ↓ CI
  ↓ GHCR image
  ↓ POST /api/platform/theme-packages/:id/artifacts
  ↓ verified digest
  ↓ preview
  ↓ production
```

The theme package may declare `deployment.strategy: registry_image` in `eshobe.theme.json`
(manifest sync copies it to the CMS row) or set `deploymentStrategy`, `registryProvider`,
`registryImageRepository` and `registryVisibility` manually in the admin. The manifest still
controls the runtime/build contract. The CI callback supplies repository, commit SHA, image repository,
`sha256:` digest, workflow URL/id, SBOM/provenance flags and timing. The CMS verifies:

- callback HMAC `X-Eshobe-Signature-256: sha256=<HMAC raw body>` with
  `ESHOBE_THEME_ARTIFACT_SECRET`;
- source repository matches the Theme package;
- image repository matches `registryImageRepository`;
- commit SHA and digest syntax are strict;
- duplicate package + commit + digest is idempotent.

Production deploys prefer `ghcr.io/owner/image@sha256:<digest>`, not a mutable tag. Existing
`theme-artifacts` rows remain immutable rollback inputs.

### Operational flow

```text
GitHub push
  ↓
CMS webhook verifies GitHub signature
  ↓
manifest sync validates and stores manifest/designDefaults/syncedCommitSha
  ↓
Sites show “update available” when their deployed commit differs
  ↓
Operator deploys preview or production explicitly
```

There is no automatic production deployment in v1. Preview and production use separate
Theme Bindings; production promotion happens only after health verification, and a failed
production attempt never destroys the previous healthy state.

### Security checklist for theme authors

- Never accept `?site=`, `tenant`, or public `siteId` as tenant authority.
- Never log `ESHOBE_API_KEY`, `ESHOBE_REVALIDATE_SECRET`, tenant secrets or registry credentials.
- If `proxiesApi: true`, proxy only CMS-owned API paths and keep `/api/revalidate` local.
- Verify revalidation signatures before purging cache.
- Treat `themeRuntime.settings` and `bindings` as validated presentation input, not secrets.
- Use immutable image digests for registry deployments.
