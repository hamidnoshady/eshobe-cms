# Wave 9 — the headless contract

The site builder (the SaaS app customers actually touch) is being developed **as a
separate app**. That changes one thing fundamentally and one thing slightly.

*Fundamentally*: this repo is no longer the only renderer. Every guarantee that lived
in `src/lib/site-query.ts` — "front-end reads are always tenant-scoped" — protected one
codebase. A second consumer arrives through Payload's REST/GraphQL API and never sees
that file.

*Slightly*: the CMS's own site rendering (`src/app/(site)`, `src/blocks`) stops being
the definition of "the frontend" and becomes a **reference implementation** that the
builder either copies or imports.

This wave is the contract that makes both true at once: attach by API, or mount the
runtime wholesale. Slice 1 (public-read scoping, `/api/site`, CORS) is implemented;
the rest is listed with its size so it can be scheduled.

---

## 1. Shipped: the tenant is decided by the `Host`, not by the caller

`src/access/siteRead.ts` wraps each public collection's `read` access with a scope
derived from the request's `Host`, the same lookup `src/proxy.ts` and the Wave 7
checkout use. Wrapped: `pages`, `posts`, `products` (published + tenant) and `media`,
`categories`, `theme`, `header`, `footer`, `store` (tenant).

The property a frontend can rely on:

> A client's `where` may **narrow** a public read and can never **widen** it.
> `?where[site][equals]=<someone-else's-id>` intersects with the host's site and
> returns nothing.

Why the access layer and not the query layer: `findForSite()` is a convention inside
this app. A convention cannot be enforced on a process you do not ship, and the
multi-tenant plugin ANDs its constraint only for a **logged-in member of the admin
users collection** — an anonymous storefront request gets none of it. `tests/int/tenancy.int.spec.ts`
already said so out loud ("access control alone does not scope anonymous reads"); that
test still passes, and it is now a description of a carve-out rather than the whole
story.

Covered by `tests/int/headless.int.spec.ts` (11 tests): host scoping per collection,
the cannot-widen property, drafts still invisible, one theme per host, `store` readable
without its `paymentInstructions`, and an explicit test pinning the fail-open below.

### The carve-out, stated rather than buried

When the host resolves to no site — the control plane, and every non-request context
(CLI seed, job tasks, hook-time writes, `createLocalReq` in tests) — **nothing is
added**. Failing closed there would mean a reindex task or a provisioning script has to
fabricate a `Host` header to touch the tenant it already owns, which trades a real leak
for an unfathomable one. The way to close it is at the proxy (deny anonymous `/api/*`
on the control-plane host) plus per-site API keys, which is slice 9.4 — config, not
another hook.

## 2. `GET /api/site` — what a renderer needs before first paint

One call, per `Host`, and one answer: `domain`, `name`, `slug`, `type`,
`availableLocales`, `defaultLocale`, `blocks` (the same table the admin's block picker
uses, `src/blocks/index.ts`), `theme` tokens, `store` `{ currency, paymentProvider }`,
and `media.{origin, basePath}`. `Vary: Host`, cached 30s publicly.

Each field exists because the alternative is a second app guessing:

| Field | What goes wrong without it |
|---|---|
| `availableLocales` | `/de` on a `fa`+`en` site falls back and **duplicates the home page** under a URL that should 404 |
| `defaultLocale` | the builder prefixes every URL with `/fa`, so the canonical Persian URL grows a second spelling |
| `blocks` | "saved fine, rendered nothing" — the failure `tests/int/blocks.int.spec.ts` guards inside this app |
| `theme` | the builder ships a default palette and every customer's brand is silently ignored |
| `store.currency` | a price with no unit: the Toman/Rial error, off by 10×, invisible in the number itself |
| `media.origin` | local uploads are served relative (`/api/media/file/x.png`), which resolves against the *builder's* own domain → broken images. See §5: #15 moves media to R2 with absolute URLs, after which `media.basePath` goes away and only `origin` stays |

Unknown host → `404 {error:'unknown-host'}`. It never lists sites; `domainCheck` is the
same shape for the same reason.

## 3. What the builder must reproduce (or import)

The API carries content; these rules are **not** in the payload and are the ones
`CLAUDE.md` exists for. Reimplementing them per-app is how a Persian-first platform ends
up with an English date on a customer's homepage:

1. **Every date through Shamsi-on-`fa` formatting, every number through the Persian
   digit formatter, every price through `formatPrice(minor, site.currency, locale)`.**
   Import `src/lib/format.ts` + `src/lib/money.ts` (they are pure, no Payload, no Next)
   rather than copying them.
2. **`dir` from the locale, never from the site.** A bilingual site flips direction per
   locale; body `line-height` ≈ 1.8; logical CSS only.
3. **Media URLs**: `new URL(doc.url, site.media.origin)` for local storage. Once #15
   (R2 via `@payloadcms/storage-s3`) is merged the stored `url` is already absolute and
   the join becomes a no-op — do it in one place so the switch is a deletion, not a
   hunt through a frontend.
4. **Slug→path**: the home page is `/`, `pagePath()` owns that; the default locale has
   no prefix; internal rich-text links resolve through the CMS's `link` field, never by
   string-concatenating a slug.
5. **Prices are integer minor units of the site's currency.** Read the integer, render
   with the helper, and never convert Toman↔Rial in the client — the 10× step lives in
   `src/lib/money.ts` and nowhere else.
6. **Draft preview** requires the same three pieces the site layout has: a
   `/next/preview` route that checks `PREVIEW_SECRET` and turns on `draftMode` with
   `__prerender_bypass` **and** `payload-token` set `SameSite=None` (the admin is on a
   different origin — see `src/app/(site)/next/preview/route.ts`), `RefreshRouteOnSave`
   listening to `payload-document-event`, and `frame-ancestors` in the CSP naming the
   admin origin. Skip one and the symptom is a blank preview pane, not an error.
7. **`select`/`depth` on reads.** `?depth=2` on a list of pages pulls every block's
   relationships; the site renderer uses `defaultPopulate` to avoid exactly this.

## 4. Identity: the builder owns users — what that means for this CMS

Decision taken: **accounts belong to the site-builder app; the CMS does not run a
customer-facing login.** That is the right way round (the builder owns the customer
relationship, the subscription, and the email), and it has three consequences that have
to be designed, not discovered:

1. **`users` cannot leave the CMS.** The multi-tenant plugin's entire scoping model is
   "the admin users collection carries a `tenants` array with a `role` per row", and the
   admin panel is Payload's — it needs an auth collection to authenticate against.
   So the CMS keeps **shadow accounts**: `users` rows whose email/name/`tenants[].role`
   mirror the builder's, with no self-service surface.
   → Provisioning is an internal, service-token-only path: `upsert by email`, called on
   login (JIT) and on membership change. `users.create/update/delete` become
   platform-admin/service only; `Users.beforeChange`'s "promote the first account when
   the DB has no platform admin" bootstrap stays (it is what makes the first install
   work, and it must not become a way in — it fires only at `totalDocs === 0` for
   `role: 'platformAdmin'`).
   → Passwords, resets, verification, 2FA, and signup move out. The shadow row gets an
   unusable random password; the builder authenticates humans and hands over a session
   (see 3).
   → **Wave 8 (billing) leaves this repo entirely.** Plans/entitlements live beside the
   accounts that pay for them; the CMS only ever reads a per-site "suspended" flag —
   which is `sites.status`, already implemented (`suspended` sites stop serving).
2. **The editor's session has to cross an origin.** Two workable shapes, pick one before
   any admin-embedding work starts:
   - *Redirect handoff* (recommended, least machinery): the builder POSTs a short-lived
     signed assertion to a CMS endpoint which sets the `payload-token` cookie on the CMS
     origin and redirects into `/admin`. Same pattern as `/next/preview`, which already
     solves "cookie can't cross sites" with a token in the URL.
   - *Payload `customAuth`*: the admin authenticates against the builder's JWT. Cleaner
     for a fully embedded admin, but it replaces the auth strategy for the whole
     collection, including the shadow-account paths above.
3. **Nothing public may authenticate as a shadow user.** `userHasAccessToAllTenants` is
   `role === 'platformAdmin'`, and the plugin short-circuits *every* tenant constraint on
   that answer — so a public route that can obtain a logged-in user is a bug, not a
   feature. `CLAUDE.md` already says to assert a fixture's `role` before trusting an
   isolation test; same rule for endpoints.

## 5. Remaining slices, with sizes

| Slice | Work | Size |
|---|---|---|
| 9.2 | **Revalidation webhook.** `revalidatePage`/`revalidateSiteGlobal` invalidate *this* app's router cache. An external renderer needs the same signal: one outbound `POST` on publish with `{siteId, paths[], token}`, HMAC-signed, retries via the jobs queue. | S |
| ~~9.3~~ | ~~Media on R2~~ — **in flight in #15** (Wave 6), which also replaces `next-sitemap` with per-site `sitemap.xml`/`robots.txt` route handlers, `hreflang` and OG images. After it lands: drop `media.basePath` from `/api/site` and re-check this file's §3.3 | — |
| 9.4 | **Close the fail-open**: deny anonymous `/api/*` reads on the control-plane host at Caddy, then per-site read API keys so a builder can call from a non-customer origin (webhooks, previews from a CMS-hosted editor). | S–M |
| 9.5 | **`search` and `redirects`** are plugin collections with public reads and are **not** yet wrapped — a builder using site search today gets cross-tenant hits. Needs the override shape of each plugin rather than a collection file. | S |
| 9.6 | **Preview handoff** (§4.2) + the builder-side `/next/preview` contract written as a test fixture. | M |
| 9.7 | **Contract hygiene**: `ETag`/`Last-Modified` on `/api/site`, a `contractVersion` field, and publishing `@eshobe/site-runtime` (format/money/theme/blocks) from the existing `pnpm-workspace.yaml` — which has no `packages:` key yet. | S |
| — | Carried from Wave 7, still open: **no rate limiting on `POST /api/checkout`**, email receipts, product pages. | M |

## 5b. Overlap with the open waves — read before merging

Waves 5 and 6 are open as PR #14 and #15, and both touch files this branch touches:

| Shared file | Why it collides | Who wins |
|---|---|---|
| `src/lib/site-query.ts` | #14 adds provisioning-time lookups; this branch refactored `getSiteByHost` into `findSiteByHost` + `siteFromRequest`, which is what `/api/site` and `/api/checkout` both use | Take #14's additions, keep the split — endpoints must not reach for `next/headers` |
| `src/endpoints/seed/index.ts`, `src/provisioning/starter-content.ts` | #14 moves starter content into plain copy tables per site type. This branch's `shop.localhost` + products + `store` doc is dev-seed only | **Follow-up owed:** port the store starter into `starter-content.ts` so a provisioned `type: 'store'` site gets a catalogue and a `productGrid` page, not just an empty shelf |
| `src/payload.config.ts` | #14 adds the provisioning endpoint, #15 the plugins/storage wiring, this branch the three collections, two endpoints and `cors` from env | Mechanical merge; keep `cors` as a list (see §1 of `CLAUDE.md`) |
| `next-sitemap.config.cjs`, `public/robots.txt` | #15 deletes both in favour of per-site route handlers | #15 — the site-level SEO surface is not this branch's |
| `src/app/(payload)/admin/importMap.js` | generated by both branches | Regenerate after the merge (`pnpm generate:importmap`) — the checked-in file is NODE_ENV-sensitive and hand-merging it is how the admin loses the tenant-assignment trigger |

Suggested order: **#15 → #14 → this**, because this branch's checkout scoping does not
depend on either, while the starter-content follow-up depends on #14's shape.

## 6. Explicitly not doing

- **Not** a GraphQL-only "content gateway" rewrite: Payload's REST shapes plus the
  access layer are the contract; `select`/`depth`/`where` are enough.
- **Not** letting the caller name a tenant (`?site=`, `x-site-id`, a JWT claim) as the
  scoping mechanism. That is the hole §1 closes, and every future feature has to keep
  it closed: the tenant comes from the socket, or from a credential, never from a filter.
- **Not** two sources of truth for users: if the builder owns accounts, the CMS stops
  offering signup, password reset and role editing, and the shadow rows are written by
  one internal path only.

## 7. Verification

`tests/int/headless.int.spec.ts` (11) · full integration suite **105 passing** ·
`tsc --noEmit` clean · `eslint` 0 errors. The scoping tests were checked for vacuity:
un-wrapping `pages` makes *"see only that host's pages"* and *"cannot be redirected to
another tenant"* fail, and restoring them turns the suite green again.
