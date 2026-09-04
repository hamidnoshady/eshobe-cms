# Eshobe CMS — Theme API Reference

**For AI agents and human developers building headless themes (including ecommerce).**

*Version: `contractVersion = 1` — `GET /api/site` returns this number. Bump = breaking change.*
*Stack: Payload 3.88 + Next 16 + Postgres + Tailwind v4. Platform is Persian-first, RTL by default, multi-tenant via `Host`.*
*Base: this repo `hamidnoshady/eshobe-cms`. Docs cover REST + Payload API, blocks, theming, i18n, money, routing and checkout.*

> **Read this once before writing code:** every date/number/price must go through `@eshobe/site-runtime` helpers, every price is integer minor units of the **site's** currency (never hardcode Toman/Rial), tenant comes from `Host` header or site API key — never from a query param/body field.

---

## Table of Contents

1. [Quick Start for an AI Agent](#1-quick-start-for-an-ai-agent-5-calls-to-a-working-store)
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
18. [Reference: Constants & Types](#18-reference-constants--types)

---

## 1. Quick Start for an AI Agent (5 calls to a working store)

You are an AI theme builder. Do this in order:

```ts
// 0. Install the runtime — it is the contract, not a copy-paste
// pnpm add @eshobe/site-runtime
import { formatPrice, formatDate, formatNumber, themeCss, blockSlugsForSiteType, slugify, toLocaleDigits } from '@eshobe/site-runtime'
import { currencies } from '@eshobe/site-runtime/money'

// 1. Bootstrap — one call tells you everything
const site = await fetch('https://CUSTOMER_DOMAIN/api/site', {
  headers: { /* Host is set by the fetch itself */ },
}).then(r => r.json())
// → { domain, name, type:"store", availableLocales:["fa","en"], defaultLocale:"fa",
//     blocks:["content","mediaBlock",...,"productGrid"], currency via site.store.currency,
//     theme:{primary,accent,background,foreground,radius}, media:{origin,basePath} }

// 2. List products (public, Host-scoped, published only)
const products = await fetch(
  `https://CUSTOMER_DOMAIN/api/products?locale=${site.defaultLocale}&limit=12&sort=-createdAt&depth=1`,
  { headers: {} }
).then(r => r.json())
// Each product: { title, slug, summary, image:{url}, price:180000, trackInventory, inventory }

// 3. Render a price — NEVER interpolate product.price directly
formatPrice(180000, site.store.currency, site.defaultLocale) // → "۱۸۰٬۰۰۰ تومان" on fa

// 4. Render a page's blocks (see §8). One page fetch gives you layout:
const page = await fetch(`https://CUSTOMER_DOMAIN/api/pages?where[slug][equals]=home&locale=fa&depth=2`).then(r=>r.json())
// page.docs[0].layout = [{blockType:"productGrid", populateBy:"collection", limit:6, showBuyButton:true}, ...]

// 5. Checkout — collect name/phone, POST to /api/checkout (Host-scoped)
const checkout = await fetch('https://CUSTOMER_DOMAIN/api/checkout', {
  method:'POST',
  headers:{'content-type':'application/json'},
  body: JSON.stringify({ product: products.docs[0].id, quantity:1, name:"علی رضایی", phone:"09121234567" })
}).then(r=>r.json())
// → { ok:true, redirectUrl: "https://psp.example/pay/..." | null, confirmationUrl:"/checkout/<orderId>?r=<sig>" }
// Redirect browser to redirectUrl if present, otherwise to confirmationUrl
```

**That's a shippable store theme.** The rest of this doc explains every field, edge case, and invariant behind those 5 calls.

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
  "media": { "basePath": "/api/media/file", "origin": "https://acme.ir" },
  "name": "فروشگاه نمونه",
  "slug": "acme",
  "status": "active",
  "store": { "currency": "IRT", "paymentProvider": "bank" },
  "theme": { "primary": "#0f766e", "accent": "#f59e0b", "background": "#ffffff", "foreground": "#0a0a0a", "radius": "md", "lineHeight": 1.8 },
  "type": "store"
}
```

When resolved via **site API key** (not Host), two extra fields appear (pinned by test — anonymous never gets them):
```json
{ "id": "uuid...", "domainVerified": true, "...": "..." }
```

**404 — unknown host**
```json
{ "error": "unknown-host" }
```

### Headers & Caching
- Success: `cache-control: public, s-maxage=30, stale-while-revalidate=300`, `vary: Host`, `etag: "<sha256>"`, `last-modified: <latest of site/store/theme updatedAt>`
- `If-None-Match` → `304` when ETag matches.
- API-key-resolved: `cache-control: private, no-store` (no Host to vary on, can't share cache).

### Why each field matters
- `availableLocales` + `defaultLocale` → prefix URLs correctly, 404 unserved locales (don't fall back to duplicating home page under `/de`).
- `blocks` → same allowlist the admin picker uses; warn in theme if layout contains unknown `blockType`.
- `store.currency` → the unit label (`تومان` vs `Toman`) and math.
- `theme` → emit as CSS variables (see §9).
- `media.origin` → `new URL(media.url, site.media.origin)` until R2 lands with absolute URLs.

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
`access: read = scopedPublicRead(anyone)` (public, Host-scoped). Tenant-isolated via `setMediaPrefix` (R2 key `sites/<id>/media/<filename>`). Local dev serves from `public/media` or `MEDIA_DIR`.

| Field | Type |
|-------|------|
| `alt` | text, localized |
| `caption` | richText lexical, localized |
| `prefix` | text, auto (R2 namespace) |
| `folder` | relation `payload-folders` |
| `url`, `thumbnailURL`, `filename`, `mimeType`, `filesize`, `width`, `height`, `sizes` | auto (Payload upload) |

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

Uploads are tenant-namespaced (`sites/<siteId>/media/<filename>` via `setMediaPrefix` hook, stored in R2/S3 in prod, `public/media` in dev).

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

After R2 migration (WAVE-6, env `S3_BUCKET`), `media.url` is already absolute (`https://bucket.r2.../sites/<id>/media/...`) — `new URL(url, origin)` still works (absolute stays absolute).

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
| R2 media of another site | Key prefix `sites/<id>/media/`; serving route checks site scope |
| Customer reads another's theme/store | `scopedPublicRead` with Host — one theme/store per Host |

**What is still fail-open (and why):** when `Host` resolves to no site (control plane `cms.example.com`, CLI, jobs, Local API in tests), `siteConstraint` returns `null` and adds nothing. Closing it in the access layer would break `findForSite`'s own Local calls (they also have no real Host). Close is at **Caddy** (deny anonymous `/api/*` on control-plane Host) + per-site API keys. For a theme, this means: always fetch with a Host or key, never rely on anonymous unscoped fallback.

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
content-type: application/json

{ "paths": ["/acme.ir/en/pricing", "/acme.ir/pricing"], "siteId":"...", "timestamp":"2024-05-17T10:00:00Z" }
```
Verify raw body HMAC with `PAYLOAD_SECRET`; then purge cache / revalidate path. Best-effort, 3s timeout, at-most-once — if you need at-least-once, consume jobs queue instead.

#### Domain-check (Caddy)
`GET /api/domain-check?domain=<host>` → `200 {authorised:true}` if site active+verified else `404`. Caddy's `on_demand_tls { ask http://web:3000/api/domain-check }` gates TLS issuance (prevents CA rate-limit burn). Not theme-related but required for custom domains.

#### Jobs Queue (scheduled publish)
`versions.drafts.schedulePublish` queues `schedulePublish` job with `waitUntil`. Web container's `getPayload({cron:true})` + `jobs.autoRun: "* * * * *"` runs it (VPS only — never serverless, duplicates on multi-replica). For themes: draft pages appear when job fires; webhook above notifies.

---

## 18. Reference: Constants & Types

### Slugs & Paths
```ts
HOME_SLUG = "home"
POSTS_SEGMENT = "posts";        POSTS_BASE = "/posts"
PRODUCTS_SEGMENT = "products";  PRODUCTS_BASE = "/products"
SEARCH_SEGMENT = "search";      SEARCH_PATH = "/search"
CHECKOUT_SEGMENT = "checkout";  CHECKOUT_BASE = "/checkout"
RESERVED_PAGE_SLUGS = ["posts","search","checkout"] // pages cannot use

pagePath(slug)     // "home"→"/", "about"→"/about"
postPath(slug)     // "hello"→"/posts/hello"
productPath(slug)  // "chair"→"/products/chair"
localeHref(path, locale, siteDefault) // "/about"+"en"/"fa"→"/en/about" or "/about"

isLocale(code)     // "fa"|"en" only (adding locale grows admin bundle)
dirFor(code)       // "fa"→"rtl", "en"→"ltr"
defaultLocale = "fa"
```

### Payload Config (relevant)
```ts
idType: "uuid"                          // non-enumerable across tenants
localization: { locales:[{code:"fa",rtl:true},{code:"en"}], defaultLocale:"fa", fallback:true }
cors: [getServerSideURL(), ...API_CORS_ORIGINS.split(",")]
admin language: i18n.fallbackLanguage:"fa", supported:{fa,en}
db: postgresAdapter({ prodMigrations })
editor: lexical (richText)
```

### `GET /api/site` Return Type (simplified)
```ts
type SiteDescriptor = {
  availableLocales: ("fa"|"en")[]
  blocks: string[]                 // slugs the admin can pick
  contractVersion: 1
  defaultLocale: "fa"|"en"
  domain: string
  media: { basePath:"/api/media/file", origin:string }
  name: string
  slug: string
  status: "active"|"suspended"|"archived"
  store: { currency:CurrencyCode, paymentProvider:"bank"|"http" }
  theme: { primary:string, accent:string, background:string, foreground:string, radius:"none"|"sm"|"md"|"lg", lineHeight:number } | null
  type: "business"|"portfolio"|"store"
  // + when via site API key:
  id?: string
  domainVerified?: boolean
}
```

### Collections Index
```
GET /api/pages?where[slug][equals]=...&locale=fa&depth=1
GET /api/posts?where[slug][equals]=...&locale=fa&depth=1
GET /api/products?where[slug][equals]=...&locale=fa&depth=1
GET /api/media/<id>?locale=fa
GET /api/categories?limit=100
GET /api/forms?locale=fa
GET /api/search?where[title][like]=q&locale=fa&limit=10
GET /api/store?limit=1
GET /api/theme?limit=1
GET /api/header?limit=1
GET /api/footer?limit=1
GET /api/redirects?where[from][equals]=/old&limit=1
```

### GraphQL
```
POST /api/graphql          # query against generated schema (same access)
GET  /api/graphql-playground  # dev only
```
Polls through same `scopedPublicRead`. Prefer REST for themes (simpler tenant mental model; `where` matches docs).

### API Keys
```ts
// Mint (platform key only):
POST /api/api-keys/issue   {name, role:"site"|"platform", siteId?}  → {id, key:"eshobe_live_...", prefix, role}
// List:
GET /api/api-keys/list?siteId=<uuid>  → {docs:[{id, name, prefix, role, siteId, createdAt, lastUsedAt}]}
// Revoke:
POST /api/api-keys/revoke  {id} → {ok:true}
// Auth: Authorization: Bearer <raw key>
```

### Provisioning (operator)
```ts
POST /api/provision-site  { name, domain, type, availableLocales, defaultLocale, ownerEmail, ... } → { site, summary, users }
```

### Handoff (builder → CMS admin)
```
POST /api/handoff  {token, redirect?, secret?}  → 302 Set-Cookie: payload-token=...; SameSite=None
GET  /api/handoff?token=...&secret=...            → 302
// same contract as src/app/(site)/next/preview — PREVIEW_SECRET / HANDOFF_SECRET
```

### Preview (site)
```
GET /next/preview?slug=...&secret=PREVIEW_SECRET&locale=fa  → draftMode + payload-token SameSite=None + redirect
GET /next/exit-preview                                    → exit
// Needs RefreshRouteOnSave + frame-ancestors CSP allowing admin origin
```

---

## Appendix: Do & Don't

**Do**
- Call `GET /api/site` once and cache (30s, `vary: Host`).
- Use `localeHref` for every internal link; canonical via `siteUrl`.
- Render rich text fields' own `direction`; one English quote inside Persian needs `dir="ltr"` on its wrapper + `unicode-bidi: plaintext`.
- Reuse `@eshobe/site-runtime` — it's the only implementation of Shamsi digits, Toman label after number, Vazirmatn OG fix.
- Set `FallbackLocale:false` when building sitemap/hreflang.

**Don't**
- Never pass `site` from client body — server derives it.
- Never float-parse a price — `validatePriceMinor` enforces integer minor.
- Never use physical Tailwind (`pl-`, `ml-`, `text-left`) — they silently RTL-break and ESLint bans them.
- Never hardcode `posts`/`checkout`/`search` as page slugs — they are routes.
- Never call `payload.find` directly from a theme — use the REST/GraphQL tenant-scoped surface.

---

*Questions while building? Open `src/lib/*`, `src/blocks/index.ts`, `WAVE-9.md` §3 for rationale. But for AI generation, this file + `packages/site-runtime` is sufficient to ship a store theme that formats correctly, themes per customer, and checks out money without leaking a tenant.*

