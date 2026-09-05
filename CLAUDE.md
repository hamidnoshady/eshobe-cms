# eshobe-cms

Multi-tenant website platform on Payload 3 + Next.js. One deployment hosts many
customer sites (business / portfolio / store), each with its own domain, locales,
content and theme. Architecture and phasing: [`PLAN.md`](./PLAN.md).

Stack: Next 16, React 19, Payload 3, Postgres, Tailwind v4, pnpm.

---

## Persian is the base, not an option

- `defaultLocale: 'fa'`. New user-facing strings are written in Persian first.
- **Every** rendered date goes through `formatDate()` in `src/lib/format.ts` — Shamsi (Jalali) on `fa`, Gregorian on `en`. Never render a raw `Date`, ISO string, or `toLocaleDateString()` directly.
- **Every** rendered number goes through `formatNumber()` — Persian-Indic digits on `fa`. Same for prices and phone numbers; prices specifically through `formatPrice(minor, siteCurrency, locale)`.
- **Money is integer minor units of the *site's* currency** (`src/lib/money.ts`), never a float and never a Rial amount. Toman is the default (`IRT`); `1 تومان = 10 ریال` appears exactly once, in that module. A stored price carries no unit string — the unit comes from the site's `store` document, and an order snapshots both price *and* currency.
- Both are `Intl`-based (`calendar: 'persian'`). Do not add a date library.
- Vazirmatn is the only font family. Never introduce a second face for Persian text, and never a Latin-only font on a page that can render Persian.
- Body `line-height: 1.8`. Persian needs more vertical room than Latin.
- Every `slugField()` passes `slugify: slugifyField` from `src/lib/slug.ts`. Payload's own slugify is `[^\w-]+` — ASCII only — so it reduces any Persian title to `-` and every page collides on one slug.
- Payload resolves the admin language from the `payload-lng` cookie, then `Accept-Language`, then `i18n.fallbackLanguage` — so `fa` loses to any browser advertising `en-US`. `src/proxy.ts` seeds the cookie; it must set it on `req.cookies` *and* the response, or the first admin page still renders English.
- A plugin that ships no `fa` dictionary renders raw keys (`plugin-redirects:fromUrl`). Add its namespace to `i18n.translations.fa` in `payload.config.ts` — cheaper than overriding each field's `label`. Exception: `plugin-multi-tenant` overwrites its whole namespace, so its wording goes in that plugin's own `i18n` option.

## RTL

- Logical Tailwind utilities only: `ps-*` `pe-*` `ms-*` `me-*` `start-*` `end-*` `text-start` `text-end` `border-s` `border-e`.
- Never `pl-*` `pr-*` `ml-*` `mr-*` `left-*` `right-*` `text-left` `text-right`. They pass review and fail silently in production, so `eslint.config.mjs` bans them in every `src` string and template literal via `no-restricted-syntax` — no plugin, no new dependency. A genuine exception (Radix's `data-[side=…]` popover animation) takes an `eslint-disable-next-line` on the line *immediately* above the literal, with the reason above that.
- `rtl:` / `ltr:` variants only where direction genuinely differs — directional icons, carousel arrows, shadow offsets.
- `dir` comes from the active locale's `rtl` flag, per request. Never hardcode it; a bilingual site flips.
- `@tailwindcss/typography` 0.5.20 is fully logical (`padding-inline-start` throughout, no physical padding), so prose inherits direction from `<html dir>` and needs nothing extra. Rich-text wrappers still carry `dir` — from the *field's own* `data.root.direction`, not the page's — because a field can hold content in the other direction (an English pull-quote in a Persian article, or a Persian field falling back on an `/en` page). `unicode-bidi: plaintext` in `globals.css` covers blocks that disagree with their wrapper.
- `ConvertRichText` destructures exactly seven named props (`className`, `converters`, `data`, `disableContainer`, `disableIndent`, `disableTextAlign`, `nodeMap`) and silently drops everything else — `dir` and every `React.HTMLAttributes` passed to it vanish. Own the wrapper `<div>` and pass `disableContainer`.

## Multi-tenancy — the leak rules

- **Never call `payload.find` / `findByID` in front-end code.** Use `findForSite()` in `src/lib/site-query.ts`, which always sets `overrideAccess: false` and scopes by site. The Local API skips access control by default, so a direct call serves one customer's content on another's domain.
- **Every public `read` is wrapped in `scopedPublicRead`/`scopedPublishedRead`** (`src/access/siteRead.ts`). `findForSite` is a convention *inside this app*; a separately deployed renderer uses the REST/GraphQL API and never touches it, so the tenant scope has to live in the collection. A client's `where` may narrow a public read and must never widen it — that is the property, and `tests/int/headless.int.spec.ts` pins it. When a new public collection appears, `GET /api/site`'s `blocks` and the scoping test are the two places to update.
- **The tenant comes from the socket, never from a parameter.** No endpoint accepts a site id: `POST /api/checkout`, `GET /api/site` and `domainCheck` all resolve from `Host`. A public route that can obtain a logged-in `users` session is a bug — `userHasAccessToAllTenants` short-circuits every constraint for `platformAdmin`.
- **Any new public API route needs a Caddy carve-out.** `/api/*` 404s on customer domains by design, so a route that works in dev and fails in production is that list being forgotten (`Caddyfile`; carve-outs today: form-submissions, checkout, payments/methods, site, media files, site/domain, cms content). A carve-out is added for a *public* route only — `POST /api/payments/self-test` and `/cancel` are staff endpoints and are deliberately left behind `@control_plane_paths`, because routing a customer domain to them puts a staff-only endpoint one `curl` away from anybody on a shop's homepage.
- **A site route is a case in `src/lib/site-route.ts`, never a new folder under `[domain]`.** A static segment cannot sit behind the locale prefix, so `[domain]/posts/…` serves `/posts` and 404s `/en/posts` — a route that looks fine on the default locale and is broken on every other. Add the segment to `RESERVED_PAGE_SLUGS` too, or a page can claim the word and be shadowed by the route with a 200 and no error.
- **Every new collection must be registered in the multi-tenant plugin's `collections` map.** An unregistered collection is shared across all tenants — a silent leak, not an error.
- Per-site singletons are collections marked `isGlobal: true`. Never Payload globals; they cannot be tenant-scoped.
- Public `read` access returns a `Where` constraint (`{ _status: { equals: 'published' } }`), never a boolean. `draft: true` on a read does not filter drafts.
- `cleanupAfterTenantDelete` stays `false`. It cascade-deletes every document a site owns.
- Slug uniqueness is enforced per `{ site, locale }` by hook — the plugin does not do it.
- **A public write takes its tenant from `Host`, never from the body.** `POST /api/checkout` and the form-builder's submissions both resolve the site server-side; `site` in a request body is ignored. Public `create` access plus a settable tenant field is the leak, not an oversight.
- A `platformAdmin` skips every tenant constraint (`userHasAccessToAllTenants` short-circuits the plugin's access wrapper). An isolation test whose fixture user is accidentally an admin passes vacuously — assert the fixture's `role` before anything else.
- `Users.beforeChange` promotes an account to `platformAdmin` when the database has none. Create the admin before any tenant user, or the first customer owner gets the platform.
- `revalidatePath` calls include domain and locale: `/{domain}/{locale}/{slug}`.
- Media in R2 is namespaced per site (`sites/<id>/media/<filename>`, set by `src/hooks/mediaPrefix.ts`). Filenames are unique per collection, not per tenant, so without it two customers' `logo.png` are one object. The prefix is stamped once at create and never re-derived — the file already sits at the old key.
- `@payloadcms/plugin-ecommerce` is not used, and `customers`-as-`users` cannot work here at all: an account with no tenant is denied its own cart, and a tenant member reads the site's drafts. The reasoning and the measurements are in `WAVE-7.md` — re-read it before re-proposing the plugin.

## Payload

- **Never add `localized: true` to a field that already holds data** — it destroys that field's data. Needs a written migration.
- Localize the text fields *inside* blocks, never the `layout` array itself.
- An unlocalized array field (`layout`) updated via the Local API on a second locale is *replaced*, not merged — a freshly built array destroys the default-locale text inside every row. Preserve each row's `id` (map over the existing doc's rows) — that is the whole difference between a translation and a rewrite. Admin writes send the ids, so this only bites Local-API/seed code.
- `push` is dev-only. Never mix it with `migrate` against the same database. Commit every migration file.
- A generated `down` that drops a relationship is broken on arrival: `DROP TABLE … CASCADE` already removed the `*_rels` constraint, so the explicit `DROP CONSTRAINT` throws. Patch the generated file to `DROP CONSTRAINT IF EXISTS` and prove `up → down → up` against a real database before committing (`20260827_*_wave7_store.ts`).
- **Field-level `access.create`/`access.update` is enforced in `beforeValidate`, not `beforeChange`** (`fields/hooks/beforeValidate/promise.js`): a denied field is `delete`d from `siblingData` and then falls back to the original document's value. Two consequences. A *collection* `beforeChange` hook runs afterwards and can still set a field whose write access denies callers — which is how derived columns (`payment-gateways.title`, `credentialsSummary`, `selfTest*`) stay unwritable from outside and correct from inside. And a denied field never throws, so a hook that merges over "what the caller was allowed to submit" must not assume it sees the stored value.
- A `virtual: true` field gets `admin.readOnly = true` unless explicitly overridden and never persists. For a write-only secret that is the wrong tool: use a real column holding ciphertext and mask it on read (see *Payment gateways*).
- `admin.style` is a CSS properties object, not a widget name. There is no password input for a `text` field, so a secret renders in cleartext *while being typed*; the protection is at rest and on read, and the collection says so in its help text rather than implying a mask that does not exist.
- Payload validates `required` fields even when `admin.condition` hides them. A required field on one variant of a conditional group makes every other variant unsavable — which is why no `payment-gateways` credential column is `required` and `assertGatewayUsable` enforces "complete" per gateway instead.
- Env var is `DATABASE_URL`, not `DATABASE_URI`.
- Keep `i18n.supportedLanguages` to `fa` and `en`. Each one adds to the admin bundle.
- There is no publish permission. `getDocumentPermissions` probes `update` access twice — once with `data._status: 'draft'`, once with `'published'` — and hides the Publish button on the second answer. So `writeUnlessPublishing()` in `src/access/publish.ts` gates the button *and* the REST/Local API in one function; a custom admin component would be dead code.
- The block library and its per-site-type gating live in `src/blocks/index.ts`: a typed registry table (`{ block, siteTypes }[]`), not a `custom` key per block — a misspelt site type in `custom` silently hides a block from every site, the table does not compile. `allowedBlocks` (a `blocks` field `filterOptions`) reads the site's `type` and returns the allowed slugs; Payload re-checks it on save, so it gates the Local/REST API, not just the picker. A block added here with no entry in `RenderBlocks.tsx` saves fine and renders nothing — `tests/int/blocks.int.spec.ts` checks the two lists against each other.
- The jobs queue only runs if something calls `getPayload({ config, cron: true })` — `jobs.autoRun` alone schedules nothing in Next.js. `src/instrumentation.ts` does it once per server process. Without it a due `schedulePublish` job sits in `payload_jobs` with `total_tried: 0` and the document never publishes, with no error anywhere.
- A write from the jobs queue, a seed or the CLI has no Next request, so `revalidatePath`/`revalidateTag` throw `Invariant: static generation store missing` — and that failure fails the *write*. Every revalidation goes through `tryRevalidate()` in `src/hooks/revalidate.ts`; a cache hint is best-effort, a publish is not.
- `autoRun` is single-replica only, and never serverless. Two web replicas run the same cron against the same queue and every scheduled publish happens twice, silently. `JOBS_AUTORUN=false` plus a `payload jobs:run` container is the upgrade path.
- Anything that enumerates a document's locales (hreflang, sitemap) must read with `fallbackLocale: false`. With the fallback on, an untranslated page reports the *Persian* slug for `en`, and `where: { slug }` does not fall back — so the URL it advertises 404s.
- The home page is `/`, never `/home`. `HOME_SLUG` and `pagePath()` in `src/lib/slug.ts` are the only code that knows the reserved slug — links, revalidation and the route resolver all go through them, or the front page grows a second URL. Rich-text internal links go through `CMSLink` (via the `link` JSX converter override in `src/components/RichText`), not a hand-built `/${slug}` — the default converter gives the home page `/home` and drops the locale segment.

## Payment gateways (Wave 10)

ZarinPal, Digipay, Snapp!Pay, Torob Pay. Design decisions in `WAVE-10.md`, operator and headless documentation in `docs/payment-gateways.md`. The rules that are easy to break:

- **A credential is never returned by anything.** Three layers, and all three are needed: AES-256-GCM at rest (`enc:v1:…`, `src/payments/gateways/crypto.ts`), field access locked to `platformAdmin`, *and* an `afterRead` hook that blanks the value unless `req.context[SECRET_READ_CONTEXT_KEY]` is set. The hook is not redundant with field access — `overrideAccess: true` is used all over this codebase for legitimate reasons and bypasses field access entirely, and a context flag only `resolve.ts` sets cannot be widened by a future change to it.
- **Never add a credential column by hand.** Every key in `credentialFieldCatalogue` (`src/payments/gateways/registry.ts`) becomes a column in `PaymentGateways` automatically, platform-admin-locked and masked. A column added outside that path is a column nothing encrypts, so it stores plaintext. `tests/int/gateways.int.spec.ts` walks both tables and fails on a mismatch in either direction.
- **An empty credential field means "unchanged", never "delete".** The fields render empty, so every save submits them empty; treating that as deletion wipes a merchant's secret the moment somebody edits the row's priority. `encryptGatewayCredentials` merges typed values over a re-read of the stored ciphertext, and `clearCredentials` is the explicit door for wiping a row.
- The re-read is `findByID` with `overrideAccess` + the secret flag, **not** `originalDoc` — the update operation's copy has already been through field access and the masking hook.
- **A callback value is never why an order becomes `paid`.** `confirm` asks the PSP server to server. `callback.query`/`callback.body` are for lookups (which attempt is this?) and cross-checks (does the echoed amount match the order?) only. The `st` HMAC on the callback URL stops an order id being driven by a stranger; it does not decide anything.
- **Money conversion lives in `src/lib/money.ts` and nowhere else.** Adapters use `amountIn` and `amountMatches`; an order carries a snapshot of its site's currency, and a gateway's window is verified against *that*, not against the site's current setting — a site switched from Toman to Rial must not invalidate its pending orders by a factor of ten.
- **`gatewayAdapters` is typed `Record<GatewayId, GatewayAdapter>`** so a descriptor with no adapter is a compile error rather than a runtime `undefined` on somebody's checkout. Adding a gateway is four files (`WAVE-10.md` §8) plus a migration for the enum value.
- Refusal reasons shown to a buyer are deliberately coarse Persian; the specific detail goes to the log. A public checkout that explains *how* a gateway is misconfigured is a free probe into which customers hold which PSP accounts.
- A row's `gateway` is immutable after create: it decides which adapter runs and which columns its ciphertext lives in, so changing it would attribute one provider's encrypted secret to another's field.
- `payment-gateways` **is** in the multi-tenant plugin's `collections` map. This is the one collection where an unregistered entry would not merely leak content — it would hand every tenant a form for every other tenant's PSP account.
- Rotating `PAYMENT_GATEWAYS_KEY` or `PAYLOAD_SECRET` invalidates every stored credential and there is no re-encryption job. A row whose secrets no longer decrypt is *refused*, not errored, so the symptom is "the gateway disappeared from the storefront".

## Commands

```bash
pnpm dev                     # Next + Payload
pnpm payload migrate:create  # after config changes, before deploy
pnpm payload migrate:status  # check before touching a shared DB
docker compose up -d db      # local Postgres
```

## Gotchas

- Windows does not resolve `*.localhost`. Add hosts entries (`scripts/dev-hosts.ps1`) or multi-domain dev silently fails — Chromium resolves it itself, so Playwright needs no entry but `curl` and Node do.
- Host rewriting and `x-locale` live in `src/proxy.ts`, not `middleware.ts`: Next 16 deprecated that filename and warns on every boot. Same contract, same `config.matcher`, exported as `proxy`.
- Side effects that hang off a save (renderer webhook, buyer email) are best-effort: `void` + log, never awaited-fatal. A paid order must not be lost because a third-party cache endpoint or an SMTP relay was down. The cost — at-most-once — is stated in the file.
- Env-tunable limits (`CHECKOUT_RATE_LIMIT`, duplicate window, webhook URL) are read **per call**, not at module load; a constant captured at import time is silently frozen and untestable.
- Live preview iframe stays blank unless `frame-ancestors` allows the admin origin. A second renderer needs the same three pieces as this app: the `/next/preview` secret check, `draftMode` + `payload-token` as `SameSite=None`, and `RefreshRouteOnSave` (WAVE-9.md §3.6).
- Payload's admin date picker is Gregorian. A Jalali picker needs a custom field component — not yet built.
- `filterAvailableLocales` resolves once at the app root and goes stale on tenant switch; `router.refresh()` on change.
- A collection field named `locales` creates `<collection>_locales` — the table Payload reserves for that collection's localized fields. The clash breaks drizzle's relation builder with `Cannot read properties of undefined (reading 'referencedTable')`. `sites.availableLocales` is named that way for this reason.
- Localized `slug` means a page is only reachable in locales that have a slug row. The `generateSlug` checkbox defaults on per locale, so a translation pass generates one — but a `where: { slug: … }` read never falls back to the default locale, so every page the nav links to must exist in *every* locale the site serves or the link is a 404.
- Payload's admin layout writes `dir="RTL"` uppercase; the site layout writes lowercase. Assert it case-insensitively.
- Playwright's `webServer` readiness probe rejects a 404, and plain `localhost/` belongs to no site — so its `url` is `/admin/login`, with `timeout: 180_000` for a cold Payload dev boot.
- `sites.name` is deliberately not localized: `getSiteByHost` must resolve the site *before* the locale is known (the locale comes from `site.availableLocales`), so a localized `name` would only ever return the default locale.
- Seeding runs outside a Next request: every write needs `context: { disableRevalidate: true }`, deletes included, or `revalidatePath` throws `static generation store missing`.
- Lightning CSS rewrites `oklch()` to `lab()` in the built stylesheet. A computed-style test must not assert an authored `oklch(...)` literal — assert behaviour (before/after a change) instead.
- Vitest's default `hookTimeout` (10s) is too short for `getPayload()` in a `beforeAll` on a cold Postgres connection — it pulls the schema first. `vitest.config.mts` sets 120s; without it the int suite flakes whenever the dev server competes for connections.
- Satori (`next/og`) keys a font face by name + weight + style, so registering the Vazirmatn `arabic` and `latin` subsets under one family silently drops one of them — an English title renders as a single letter. Different family names, listed in `fontFamily`. It also ignores `direction: rtl` for flex alignment (align on an LTR wrapper instead), reads `woff` but not the `woff2` that `next/font` downloads, and `new URL('./fonts/' + name, import.meta.url)` with a template traces the whole directory and returns the wrong file.
- `robots.txt` and `sitemap.xml` are per-site route handlers under `[domain]`, not files in `public/`. They must stay *out* of the `src/proxy.ts` matcher exclusions or they never reach the site route.
- Production refuses to boot on a placeholder or short secret (`src/lib/env.ts`, called from `onInit`). The check is keyed on `NEXT_PHASE`, not `NODE_ENV`, because the Dockerfile builds with `NODE_ENV=production` and deliberate dummy secrets.
- A production container pointed at a database built with dev `push` stops on an interactive prompt and never becomes healthy. Migrated databases only.
- Playwright's `reuseExistingServer: true` will attach to a *hung* dev server on port 3000 (accepts connections, never responds — `curl` returns `000`). Every e2e test then times out. Kill the stale PID (`netstat -ano | grep :3000`, `taskkill //PID <pid> //F`) before blaming a code change — the symptom is a wholesale failure including tests you did not touch.

## Provisioning (Wave 5)

- `provisionSite` in `src/provisioning/provisionSite.ts` is the one action: site doc + theme + pages + nav + form + translations + invites. It re-checks `platformAdmin` itself — the endpoint check is convenience, the function is the boundary.
- Every write threads one `req` carrying `transactionID` from `payload.db.beginTransaction()`, so a mid-flow failure rolls the whole site back. Commit before sending invite emails — a rolled-back site must not have mailed anyone.
- Deleting a site whose users still reference it fails *confusingly*: Payload swallows the per-doc FK failure inside `delete`, then the preferences cleanup dies with `current transaction is aborted` on `payload_preferences`. Delete or detach the users first — `cleanupAfterTenantDelete` stays `false` on purpose.
- `payload.forgotPassword` **returns** the raw reset token, but `resetPasswordToken` is a hidden auth field: reads need `showHiddenFields: true` or the token comes back `undefined`. Never surface the token in an API response — the invite *is* the set-password email.
- Local-API `login`/`resetPassword` (jose JWT signing) cannot run under vitest's jsdom environment: the sandbox splits realms and jose rejects the other realm's `TextEncoder` output (`payload must be an instance of Uint8Array`). DB-only specs that need auth flows get `// @vitest-environment node`.
- A Next.js page cannot set an arbitrary status code, so the suspended/archived holding page answers **200 + `noindex`**, not 503. `getSiteByHost` resolves the site regardless of lifecycle; `getSiteContext().serving` (`status === 'active'`) is what gates content, chrome and theme — never key a content read off the raw site.
- Starter-content translation pairs layout rows by index between locales — both locales must build the same block sequence. That invariant is asserted in `tests/int/provisioning.int.spec.ts`; `starterPages`/`starterNav` live in `src/provisioning/starter-content.ts` as plain functions and copy tables, deliberately not a template engine.

## Working style

- Read `PLAN.md` before starting a wave; deployment specifics live in `WAVE-4.md` (domains, TLS), `WAVE-6.md` (R2, SEO, jobs, backups), `WAVE-7.md` (the store and why `@payloadcms/plugin-ecommerce` is not used), `WAVE-9.md` (the headless contract) and `WAVE-10.md` (Iranian payment gateways). Waves are tracked as GitHub issues #1–#9 under #10.
- Wave 1 gates everything: do not start Wave 2 until its cross-tenant and draft-leak tests pass.
- When adding a collection, add its cross-tenant leak test in the same change.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
