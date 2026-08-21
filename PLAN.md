# eshobe-cms — Plan

Multi-tenant website platform on Payload 3: one deployment hosting many customer
sites (business, portfolio, store), each with its own domain, languages, content
and theme.

**Persian-first.** `fa` is the base locale, the default text direction is RTL, and
the default typeface is Vazirmatn. Latin locales are the secondary case, not the
default — see §3.

**Status:** planning. No code yet. Verified against Payload docs (~v3.85, Aug 2026).

---

## 1. Recommended architecture

**One Next.js app with Payload embedded. One Postgres. Tenancy at runtime.**

A request arrives on `acme.com` → Next rewrites by `Host` → the page is rendered
from rows in a shared database scoped by a `site` relationship. Adding a customer
is an INSERT, not a deploy.

| Concern | Decision | Why |
|---|---|---|
| Tenancy | `@payloadcms/plugin-multi-tenant`, `tenantsSlug: 'sites'` | Official, does the admin scoping we'd otherwise hand-roll |
| Isolation | Shared DB, `site` relationship on every collection | Row-level. Schema/DB-per-tenant costs migrations × N for no MVP benefit |
| Routing | `next.config` `rewrites()` on `Host` | Official pattern. Config, not middleware code |
| Languages | Persian `fa` base + RTL, per-site locale subset | Locked in Wave 1 — see §3 |
| Typography | Vazirmatn via `next/font/google`, self-hosted at build | On Google Fonts (v16, 100–900), covers Persian *and* Latin in one family |
| Direction | `dir` from the active locale's `rtl` flag | Bilingual sites flip direction per locale, so it can't be global |
| Site type | Field on `sites`: `business \| portfolio \| store` | Gates available blocks. Not separate deploys, not separate collections |
| Pages | One `pages` collection, `layout` blocks field | One block library, filtered per site type |
| Theming | Per-site token doc → Tailwind v4 `@theme` CSS variables | v4 theme tokens *are* CSS variables, so a per-site override is just re-declaring them at `body` scope |
| Per-site singletons | `isGlobal: true` collections | Payload *globals* cannot be tenant-scoped — see §4.1 |
| Custom domains | Caddy on-demand TLS + `ask` endpoint | ~8 lines of Caddyfile vs. a cert/domain-API integration |
| Hosting | VPS + Docker Compose (web, postgres, caddy) | On-demand TLS needs a long-lived process; also makes the jobs queue trivial |
| Media | `@payloadcms/storage-s3` → Cloudflare R2, per-site prefix | S3-compatible, no egress fees |
| Provisioning | Internal "New site" action, agency-operated | See §2 |
| Store | `@payloadcms/plugin-ecommerce` (Beta) | Wave 7, highest risk — see §7 |
| Billing | `@payloadcms/plugin-stripe` | Wave 8, deferred — not on the critical path |

### Start from the website template, not from blank

```bash
pnpx create-payload-app eshobe-cms -t website
```

The template already ships Pages, Posts, Media, Categories, 5 layout blocks
(Hero, Content, Media, CTA, Archive), drafts + draft preview, SSR live preview,
SEO plugin, Search plugin, Redirects plugin, jobs queue + scheduled publish,
on-demand revalidation hooks, and Next 16 / React 19 / Tailwind v4 with
shadcn/ui. That is most of Waves 2, 3 and 6 already written.

Adding multi-tenancy to the template is a small, well-understood diff. Adding a
page builder, live preview, SEO and revalidation to the bare multi-tenant example
is not. Read `npx create-payload-app --example multi-tenant` for reference and
port its config across.

**Four template things must be actively undone** (details in Waves 0–1): it
defaults to `@payloadcms/db-mongodb`, and it carries two Payload globals,
LTR-assuming styles, and single-tenant access control and revalidation paths.

---

## 2. Locked decisions

| # | Decision | Choice | Consequence |
|---|---|---|---|
| 1 | Multilingual | **Yes — Persian base, RTL** | `defaultLocale: 'fa'`, `rtl: true`, Vazirmatn. Localization configured in Wave 1, before real content exists, avoiding the destructive retrofit (§4.6) |
| 2 | Hosting | **VPS + Docker Compose** | Caddy on-demand TLS for customer domains; jobs run in-process; no serverless constraints |
| 3 | Operator | **Agency — we create sites, clients edit content** | Wave 5 is an internal action, not a signup funnel. Billing (Wave 8) leaves the critical path. Per-site roles matter more (§4.3) |
| 4 | Editor freedom | Fixed block library + theme tokens | Predictable output, no freeform drag-drop |
| 5 | Store depth | Catalog + Stripe Checkout first, cart later | Wave 7 is deliberately last and starts with a spike |

Because we operate the sites, the admin panel is the product surface for clients.
That raises the value of per-site roles and lowers the value of self-serve
onboarding polish — the plan is weighted accordingly.

These decisions are restated as enforceable rules in [`CLAUDE.md`](./CLAUDE.md),
which is the working contract: Persian-first content, `formatDate`/`formatNumber`
for every date and number, Vazirmatn only, logical Tailwind utilities only, and
the multi-tenancy leak rules. This plan carries the reasoning; `CLAUDE.md` carries
the rules. Written in Wave 0 so they bind from the first commit of real code.

---

## 3. Persian-first, RTL and localization

Locked as decision #1, so the shape is settled now rather than discovered later.

### 3.1 Locales

```ts
localization: {
  locales: [
    { label: 'فارسی',   code: 'fa', rtl: true },
    { label: 'English', code: 'en' },
  ],
  defaultLocale: 'fa',
  fallback: true,
  filterAvailableLocales: async ({ req, locales }) => /* active site's subset */,
}
```

`rtl: true` is documented to render the admin UI right-to-left and set default
text alignment on inputs to rtl, so the editing experience is Persian-native for
free.

**Per-site locale subsets.** `sites` carries `locales` (array of codes) and
`defaultLocale`; most sites will be `fa`-only, some `fa` + `en`.
`filterAvailableLocales({ req, locales })` narrows the admin locale selector to
the active site's subset. Documented caveat: it resolves once at the app root and
is not recomputed on navigation, so a small client component must call
`router.refresh()` when the active tenant changes — pair it with the
`useTenantSelection` hook from `@payloadcms/plugin-multi-tenant/client`, whose
`setTenant({ refresh: true })` already supports this.

### 3.2 Admin panel in Persian

Separate from content localization: Payload's *interface* language is the `i18n`
key, and Payload ships Persian translations (`packages/translations/src/languages/fa.ts`,
confirmed present).

```ts
import { en } from '@payloadcms/translations/languages/en'
import { fa } from '@payloadcms/translations/languages/fa'

i18n: { supportedLanguages: { fa, en }, fallbackLanguage: 'fa' }
```

Keep the list to these two — every bundled language adds to the admin JS payload.

### 3.3 Direction

Direction is **per-locale, not global** — a `fa` + `en` site flips between RTL and
LTR — so `<html lang dir>` has to be resolved server-side per request or the page
flashes the wrong direction on load.

The complication: `<html>` lives in the group's root layout, which sits *above*
`[domain]` and so receives neither the domain nor the locale as params. Resolution:

- Root layout reads `host` from `await headers()` → site → its `defaultLocale`.
- A small middleware parses the first path segment and sets an `x-locale` request
  header, which the root layout reads for the active locale.

This is the one place middleware earns its keep; everything else in §5 stays in
`next.config`. Rendered rich text also needs `dir` on its wrapper for
`@tailwindcss/typography` to place list markers and quote marks correctly.

### 3.4 Typography

**Vazirmatn** as the default, via `next/font/google` — confirmed on Google Fonts
(v16, weights 100–900) and self-hosted at build time, so no external request and
no layout shift. It covers Persian *and* Latin in one family, which avoids
per-script font switching on bilingual pages.

Persian needs more vertical room than Latin: set body `line-height` around `1.8`
in the theme tokens, not the Latin-typical `1.5`.

Ship Vazirmatn only. A per-site font picker (Estedad, Sahel — both OFL, both
needing `next/font/local`) is a `theme` field to add when a client actually asks.

### 3.5 RTL-safe blocks

Tailwind v4 makes this cheap, and getting it wrong is the most likely source of
silent visual regressions. Rule for every block built in Wave 2:

- Logical utilities only: `ps-*`/`pe-*`, `ms-*`/`me-*`, `start-*`/`end-*`,
  `text-start`/`text-end`, `border-s`/`border-e`.
- Never `pl-*`, `pr-*`, `ml-*`, `mr-*`, `left-*`, `right-*`, `text-left`,
  `text-right`.
- `rtl:` / `ltr:` variants for the cases that genuinely differ (directional
  icons, carousel arrows, shadow offsets).

Worth an ESLint rule banning the physical utilities in block components, so this
is enforced rather than remembered.

### 3.6 Dates and numbers — platform-wide rule

Iranian sites expect Shamsi (Jalali) dates and Persian-Indic digits, and this
applies to **every** date and number the platform renders — post dates, form
submission timestamps, order dates, admin-facing lists, prices. Not just article
bylines.

Both come from the platform. No date library:

```ts
// src/lib/format.ts — the only place dates and numbers are formatted
export const formatDate = (d: Date | string, locale: string) =>
  new Intl.DateTimeFormat(locale === 'fa' ? 'fa-IR' : locale, {
    calendar: locale === 'fa' ? 'persian' : undefined,
    dateStyle: 'long',
  }).format(new Date(d))

export const formatNumber = (n: number, locale: string) =>
  new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale).format(n) // ۱٬۲۳۴
```

Enforced as a rule, not a convention: nothing renders a raw `Date`, an ISO
string, or a bare `toLocaleDateString()`. Everything goes through these two
functions, which take the active locale — so `en` pages still get Gregorian dates
and Latin digits from the same call site.

Built in **Wave 0**, before any content exists, so there is never a page that
formats dates its own way.

**Known gap:** Payload's admin date picker is Gregorian. Editors will pick
Gregorian dates in the panel even though the front end renders Shamsi. A Jalali
picker needs a custom field component — decided in Wave 3, not worked around
elsewhere.

For store prices in Wave 7, decide Toman vs Rial explicitly — the currency is
Rial but prices are quoted in Toman, and getting that wrong is off by 10×.

### 3.7 Which fields are localized

**Localize inner block fields, not the `layout` array.** Localizing a container
field creates independent localized *sets* of everything nested inside it — each
locale would get its own separate list of blocks, so editors would rebuild the
whole page structure per language. Instead leave `layout` unlocalized and mark the
text/richtext/media fields *inside* each block as `localized: true`. One shared
structure, translated copy. Cheaper to build, far less editor work, and the right
default for agency-managed sites.

Fields to localize in Wave 1:

- `pages`: `title`, `slug`, and the text fields inside each block
- `posts`: `title`, `slug`, `content`
- `media`: `alt`
- `navigation` / `footer`: link labels
- SEO plugin fields, via its `fields` override

**Localize `slug` too.** It costs a per-locale dimension on the uniqueness hook
(§4.4) but yields per-language URLs and, more importantly, avoids being the one
field left holding the retrofit trap. With `fallback: true`, an untranslated page
falls back to the default locale's slug, which routes correctly.

**Routing.** One catch-all route, `app/(site)/[domain]/[[...path]]/page.tsx`,
parses the first path segment as a locale when it matches a known code and
otherwise falls back to the site's `defaultLocale`. This is simpler than a
`[locale]` folder, which would need a redirect for bare `/` on every site.

Skip `experimental.localizeStatus` (per-locale publish state) — it is beta, and
one publish state per document is sufficient.

---

## 4. Findings that shape the design

Six things from the docs that are non-obvious and would each cause a rewrite or
a leak if discovered late.

### 4.1 Payload globals can't be tenant-scoped — use `isGlobal: true` collections

The multi-tenant plugin scopes *collections*. For per-site singletons (nav,
footer, theme, settings) declare them as normal collections and mark them
`isGlobal: true` in the plugin config; each site then gets exactly one document,
editable as if it were a global.

```ts
multiTenantPlugin<Config>({
  tenantsSlug: 'sites',
  collections: {
    pages: {},
    posts: {},
    media: {},
    forms: {},
    'form-submissions': {},
    navigation: { isGlobal: true },
    footer:     { isGlobal: true },
    theme:      { isGlobal: true },
  },
  userHasAccessToAllTenants: (user) => user?.role === 'platformAdmin',
  cleanupAfterTenantDelete: false,   // see 4.5
  debug: process.env.NODE_ENV === 'development',
})
```

The template's `Header` and `Footer` globals must be converted to collections.

### 4.2 The Local API skips access control by default — this is the leak

> "In the Local API all Access Control is *skipped* by default. Pass
> `overrideAccess: false` on a request to re-enable it."

Every front-end page render is a Local API call. So tenant scoping and
draft-hiding are **not automatic on the public site**. A forgotten flag serves
another customer's unpublished content on the wrong domain.

Mitigation — one funnel, no hand-written queries:

- A single `src/lib/site-query.ts` exposing `findForSite(collection, siteId, opts)`
  that always sets `overrideAccess: false`, `where: { site: { equals: siteId } }`,
  and the resolved `locale`.
- Review rule: no `payload.find` / `findByID` outside that module.
- Tests asserting site A's domain cannot return site B's page, and that an
  anonymous request cannot return a `draft` document.

Belt and braces, because `draft: true` on a read also does **not** filter drafts:
public `read` access on `pages`/`posts` must return a constraint, not a boolean.

```ts
read: ({ req }) => req.user ? true : { _status: { equals: 'published' } }
```

The template ships `req.user ? true : published` — in a multi-tenant app that
lets any logged-in customer read every other customer's drafts. Replace it with
a tenant-aware version.

### 4.3 Per-site roles come from the plugin's users array field

The plugin adds a `tenants` array field to the users collection and accepts
`rowFields`, so a `role` (`owner | editor`) can live on each row — a user can be
owner of one site and editor of another. Since clients work in the admin panel
directly, wire `editor` to non-publishing by returning a constraint from `update`:

```ts
update: ({ req: { user } }) =>
  user?.role === 'platformAdmin' ? true : { _status: { equals: 'draft' } }
```

Payload hides the Publish button accordingly, and this also blocks scheduled
publish jobs for those users.

### 4.4 Per-site slug uniqueness is not provided

The plugin adds a `site` field and filters queries. It does not enforce that
`/about` is unique *within* a site. Two `/about` pages on one site is an
ambiguous route. Needs a `beforeValidate` hook on `pages`/`posts` doing a count
scoped to `{ site, locale }` and throwing a field-level error.

### 4.5 Deleting a site cascade-deletes its content by default

`cleanupAfterTenantDelete` defaults to `true`. One mis-click in the admin panel
removes every document belonging to that site. Set it to `false`, restrict
`delete` on `sites` to platform admins, and use `status: active | suspended |
archived` for lifecycle instead of deletion.

### 4.6 `localized: true` added later destroys that field's data

From the localization docs: toggling `localized` on a field that already holds
data changes its storage structure and "existing data for this field will be
lost." This is the whole reason decision #1 is settled in Wave 1 rather than
deferred.

### 4.7 Windows dev needs hosts-file entries

Windows does not resolve `*.localhost` automatically. The official example edits
the hosts file, and this machine is Windows 11 — so local dev needs, as admin, in
`C:\Windows\System32\drivers\etc\hosts`:

```
127.0.0.1 acme.localhost studio.localhost shop.localhost
```

One line per test site. Worth a `scripts/dev-hosts.ps1` helper.

---

## 5. Routing

Official pattern — rewrite on `Host`, excluding the control plane:

```ts
// next.config.ts
async rewrites() {
  return [{
    source: '/((?!admin|api)):path*',
    destination: '/:tenantDomain/:path*',
    has: [{ type: 'host', value: '(?<tenantDomain>.*)' }],
  }]
}
```

Paired with `app/(site)/[domain]/[[...path]]/page.tsx`, which resolves
`params.domain` → `sites` doc → locale → page via `findForSite`.

Two consequences:

- **`/admin` stays reachable on every customer domain**, since the rewrite
  excludes it. Block it at the proxy rather than in app code — a matcher in Caddy
  returning 404 for `/admin*` and `/api*` when the host isn't the control-plane
  host. Config beats middleware.
- **Revalidation paths change.** The template's `afterChange` hooks call
  `revalidatePath('/' + slug)`. Real paths are now `/{domain}/{locale}/{slug}`,
  so every hook must resolve the site's domain and the document's locale first or
  nothing ever revalidates.

---

## 6. Waves

Each wave ends with something demonstrable. Wave 1 is the risky foundation and is
deliberately a thin end-to-end slice before any breadth.

**Wave 0 — Foundation.** Website template; **swap `@payloadcms/db-mongodb` for
`@payloadcms/db-postgres`** (the template defaults to Mongo); Postgres via Docker
Compose; `postgresAdapter({ idType: 'uuid' })` (non-enumerable IDs across
tenants); env vars `DATABASE_URL` / `PAYLOAD_SECRET`; Vazirmatn wired via
`next/font/google` with `dir="rtl"` and `lang="fa"` on the shell;
`src/lib/format.ts` with `formatDate` / `formatNumber` per §3.6, written before
any page exists so nothing formats dates its own way; `CLAUDE.md` with the
enforced rules; hosts-file helper.

**Wave 1 — Tenancy + i18n skeleton.** The whole plan stands or falls here.
`sites` collection (`name`, `slug`, `domain`, `type`, `status`, `locales`,
`defaultLocale`); multi-tenant plugin wired per §4.1; `Header`/`Footer` globals
converted to `isGlobal` collections; users' `tenants` array with per-row `role`;
access control rewritten per §4.2 and §4.3; `findForSite` funnel; localization
with `defaultLocale: 'fa'` and `rtl: true`; admin UI in Persian via
`i18n.supportedLanguages`; `filterAvailableLocales`; localized fields per §3.7;
`next.config` rewrite; `x-locale` middleware and per-locale `<html lang dir>`
per §3.3; `[domain]/[[...path]]` route with locale parsing. **Done when:** two
sites on two `*.localhost` domains each serve their own homepage, RTL in Persian
and LTR in English, and the cross-tenant + draft-leak tests pass.

**Wave 2 — Page builder.** Keep the template's 5 blocks, add what the three site
types need (Features, Pricing, Gallery, Testimonials, Team, Contact, Logos, FAQ).
Each block declares its allowed site types; the `layout` field filters `blocks`
accordingly. Inner text fields localized, `layout` itself not (§3.7). **Every
block RTL-safe with logical utilities only (§3.5), enforced by an ESLint rule.**
`theme` collection (colours, font, radius, spacing, `line-height` defaulting to
`1.8`) → Tailwind v4 `@theme` variables re-declared at `body` scope. Per-site slug
hook (§4.4). All dates and numbers through `src/lib/format.ts` (§3.6) — no block
formats its own.

**Wave 3 — Editing experience.** `versions.drafts` with `autosave: { interval:
375 }`; `admin.livePreview.url` as a function building
`https://{data.site.domain}/{locale}/{slug}` from the doc and active locale;
`RefreshRouteOnSave` from `@payloadcms/live-preview-react` in the site layout;
SEO / Search / Redirects plugins scoped to sites; form builder. Note: a
`frame-ancestors` CSP allowing the admin origin is required or the preview iframe
silently stays blank. **Decide the Jalali admin date picker here** (§3.6): a
custom field component wrapping a Persian calendar, or accept Gregorian input in
the panel.

**Wave 4 — Custom domains.** `domain` + `domainVerified` on `sites`; a
`GET /api/domain-check` endpoint that 200s only for a known active domain; Caddy
with a catch-all `https://` block, `tls { on_demand }`, and global
`on_demand_tls { ask ... }`; client-facing DNS instructions.

```caddyfile
{
  on_demand_tls { ask http://web:3000/api/domain-check }
}
https:// {
  tls { on_demand }
  reverse_proxy web:3000
}
```

The ask endpoint is mandatory — without it, anyone pointing DNS at the server can
burn the CA rate limit. Caddy issues a `GET` with the requested host as a `domain`
query parameter and treats `200` as authorised; confirm the exact contract against
the `on_demand_tls` option reference when implementing, as the automatic-HTTPS
page does not specify it.

**Wave 5 — Site provisioning.** Internal "New site" action: create the `sites`
doc, seed a starter set of pages/nav/theme for the chosen type and locales, invite
the client's users with a per-site role. Starters as seed functions, not a
template engine.

**Wave 6 — Production.** R2 via `storage-s3` with per-site prefix; per-site
`sitemap.xml` / `robots.txt` / OG images per locale; `hreflang` tags; jobs queue
for scheduled publish (`autoRun` on the single VPS container — never on
serverless, and it duplicates work if the web service is ever scaled past one
replica); `prodMigrations` passed to the adapter so migrations run at container
boot without CI database access; official multi-stage Dockerfile with
`output: 'standalone'`.

**Wave 7 — Store.** `@payloadcms/plugin-ecommerce` for products, variants, carts,
orders, Stripe payment adapter. **Timebox a spike first:** the plugin is Beta and
its interaction with the multi-tenant plugin is undocumented. If its collections
resist tenant scoping, fall back to a `products` collection plus Stripe Checkout —
catalog-and-buy-button covers most small stores and needs no cart. Shipping, tax
and subscriptions are not in the plugin either way.

**Wave 8 — Billing (deferred).** Stripe plugin, plan + entitlements on `sites`,
feature gates read from the site doc, suspended sites serve a holding page. Not on
the critical path while we operate the sites ourselves; build it when clients
self-serve or invoicing becomes the bottleneck.

---

## 7. Risks

| Risk | Handling |
|---|---|
| Cross-tenant data leak via Local API (§4.2) | Single query funnel + tests in Wave 1, before any breadth |
| Ecommerce plugin (Beta) won't tenant-scope | Spike before committing; documented fallback |
| Postgres table sprawl (blocks × locales × versions) | Localizing inner block fields rather than `layout` keeps this bounded; `blocksAsJSON` available if block tables get heavy |
| One deploy = one blast radius | Accepted. Read replicas and per-plan rate limits are the upgrade path |
| Migration drift | `push` in dev only, never mixed with `migrate`; commit every migration file |
| `filterAvailableLocales` staleness on tenant switch | `router.refresh()` from a client component bound to `useTenantSelection` (§3.1) |
| Silent RTL regressions from physical Tailwind utilities | Logical utilities only, enforced by an ESLint rule rather than review (§3.5) |
| Dates and numbers formatted ad hoc, leaking Gregorian or Latin digits onto Persian pages | Single `src/lib/format.ts` built in Wave 0; nothing calls `Intl` or `toLocaleDateString` directly (§3.6) |
| shadcn/ui and template components assume LTR | Audit them once in Wave 2 as the blocks are built; fix at the component, not per block |

---

## 8. Verification

Wave 1 (the one that matters):

1. `pnpm dev`, create sites `acme` (`acme.localhost`, locales `fa`+`en`) and
   `studio` (`studio.localhost`, `fa` only), one published page each.
2. Both domains serve their own homepage; neither serves the other's.
3. `acme.localhost:3000` serves Persian with `<html lang="fa" dir="rtl">`;
   `acme.localhost:3000/en` serves `dir="ltr"`; `studio.localhost:3000/en` does
   not exist and `studio`'s admin locale selector offers only `fa`.
4. The admin panel chrome renders in Persian, right-to-left.
5. Save a draft on `acme`, then `curl http://acme.localhost:3000/secret` while
   logged out → 404, not the draft.
6. Log in as `acme`'s owner → `studio`'s pages are absent from the admin list view
   *and* from relationship pickers.
7. Log in as an `acme` editor → no Publish button; API publish attempt rejected.
8. Automated: one test per assertion in 2–7, run in CI.

Later waves: no block renders with a physical-direction utility (lint gate); a
Persian page's dates render Jalali and its numbers in Persian digits; live preview
reflects an unsaved edit on the right domain and locale; a real domain gets a
certificate on first request and an unknown domain is refused;
`payload migrate:status` clean after a container restart.

---

## 9. Confirmed package list

```
@payloadcms/plugin-multi-tenant   @payloadcms/db-postgres
@payloadcms/plugin-seo            @payloadcms/storage-s3
@payloadcms/plugin-redirects      @payloadcms/live-preview-react
@payloadcms/plugin-form-builder   @payloadcms/plugin-stripe
@payloadcms/plugin-search         @payloadcms/plugin-ecommerce (Beta)
@payloadcms/translations          stripe
```

Notes:

- Payload's deployment docs use `DATABASE_URL`, not `DATABASE_URI`.
- The website template ships `@payloadcms/db-mongodb`; remove it in Wave 0.
- `stripe` (the SDK) is not installed automatically by the ecommerce plugin.
- Vazirmatn needs no package — `next/font/google` fetches and self-hosts it.
