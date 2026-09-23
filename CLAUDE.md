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
- **Every new collection must be registered in the multi-tenant plugin's `collections` map.** An unregistered collection is shared across all tenants — a silent leak, not an error. The **one** legitimate exception is a collection the platform owns outright — `plans`, `feature-flags`, `plugins`, `theme-templates`, `webhooks`, `webhook-deliveries`, alongside the older `api-keys`/`storage-connections`/`cdn-*`. Those are one list offered to every customer, the plugin's injected `site` field is *required* by construction (so a platform-level row would be unsavable), and "which customer owns the Pro plan?" has no answer. Taking the exception costs you `access: platformAdmin` on all four operations and a line in the `platformWide` set in `tests/int/store.int.spec.ts`, which is what stops a *tenant* collection from quietly joining that list.
- Per-site singletons are collections marked `isGlobal: true`. Never Payload globals; they cannot be tenant-scoped.
- Public `read` access returns a `Where` constraint (`{ _status: { equals: 'published' } }`), never a boolean. `draft: true` on a read does not filter drafts.
- `cleanupAfterTenantDelete` stays `false`. It cascade-deletes every document a site owns.
- Slug uniqueness is enforced per `{ site, locale }` by hook — the plugin does not do it.
- **A public write takes its tenant from `Host`, never from the body.** `POST /api/checkout` and the form-builder's submissions both resolve the site server-side; `site` in a request body is ignored. Public `create` access plus a settable tenant field is the leak, not an oversight.
- A `platformAdmin` skips every tenant constraint (`userHasAccessToAllTenants` short-circuits the plugin's access wrapper). An isolation test whose fixture user is accidentally an admin passes vacuously — assert the fixture's `role` before anything else.
- `Users.beforeChange` promotes an account to `platformAdmin` when the database has none. Create the admin before any tenant user, or the first customer owner gets the platform.
- `revalidatePath` calls include domain and locale: `/{domain}/{locale}/{slug}`.
- Media in object storage is namespaced per site (`sites/<id>/media/<filename>`, set by `src/hooks/mediaPrefix.ts`). Filenames are unique per collection, not per tenant, so without it two customers' `logo.png` are one object. The prefix is stamped once at create and never re-derived — the file already sits at the old key.
- `@payloadcms/plugin-ecommerce` is not used, and `customers`-as-`users` cannot work here at all: an account with no tenant is denied its own cart, and a tenant member reads the site's drafts. The reasoning and the measurements are in `WAVE-7.md` — re-read it before re-proposing the plugin.

## Payload

- **Never add `localized: true` to a field that already holds data** — it destroys that field's data. Needs a written migration.
- Localize the text fields *inside* blocks, never the `layout` array itself.
- An unlocalized array field (`layout`) updated via the Local API on a second locale is *replaced*, not merged — a freshly built array destroys the default-locale text inside every row. Preserve each row's `id` (map over the existing doc's rows) — that is the whole difference between a translation and a rewrite. Admin writes send the ids, so this only bites Local-API/seed code.
- `push` is dev-only. Never mix it with `migrate` against the same database. Commit every migration file.
- A generated `down` that drops a relationship is broken on arrival: `DROP TABLE … CASCADE` already removed the `*_rels` constraint, so the explicit `DROP CONSTRAINT` throws. Patch the generated file to `DROP CONSTRAINT IF EXISTS` and prove `up → down → up` against a real database before committing (`20260827_*_wave7_store.ts`).
- **Field-level `access.create`/`access.update` is enforced in `beforeValidate`, not `beforeChange`** (`fields/hooks/beforeValidate/promise.js`): a denied field is `delete`d from `siblingData` and then falls back to the original document's value. Two consequences. A *collection* `beforeChange` hook runs afterwards and can still set a field whose write access denies callers — which is how derived columns (`payment-gateways.title`, `credentialsSummary`, `selfTest*`) stay unwritable from outside and correct from inside. And a denied field never throws, so a hook that merges over "what the caller was allowed to submit" must not assume it sees the stored value.
- A `virtual: true` field gets `admin.readOnly = true` unless explicitly overridden and never persists. For a write-only secret that is the wrong tool: use a real column holding ciphertext and mask it on read (see *Payment gateways*).
- **A top-level endpoint whose first path segment is a collection slug never routes** — it 404s. Payload dispatches `/api/<first-segment>/…` against *that collection's* `endpoints` and never falls back to `config.endpoints`. `/api-keys/issue` and `/storage-connections/self-test` both sat unreachable in the top-level list while the int suite (which imports the handlers, no router) stayed green; both are collection endpoints now (`ApiKeys`, `StorageConnections`), same public URLs. Before adding an endpoint, check its first segment against every collection slug — and pin it with an HTTP-level test (`tests/e2e/api-keys.e2e.spec.ts` is the pattern), because a handler-level int test cannot see this class of bug.
- An API key is **issued, never created**: `ApiKeys.access.create` is `false` because a row made through the collection's create route is a credential nobody can ever read back (the mint runs in `mintOnCreate`; only `POST /api/api-keys/issue` and its admin view `/admin/collections/api-keys/issue` hand the raw value out, once). The raw key exists in exactly one response and nowhere else — no cookie, no sessionStorage, no afterRead handoff across the admin's create redirect.
- `admin.style` is a CSS properties object, not a widget name. There is no password input for a `text` field, so a secret renders in cleartext *while being typed*; the protection is at rest and on read, and the collection says so in its help text rather than implying a mask that does not exist.
- Payload validates `required` fields even when `admin.condition` hides them. A required field on one variant of a conditional group makes every other variant unsavable — which is why no `payment-gateways` credential column is `required` and `assertGatewayUsable` enforces "complete" per gateway instead.
- Runtime env var is `DATABASE_URL`, not `DATABASE_URI`: in production it belongs to the restricted `eshobe_app` role. **Never give web `MIGRATE_DATABASE_URL`, use a privileged runtime URL, or restore `prodMigrations`.** The one-shot `pnpm migrate` command uses `MIGRATE_DATABASE_URL` (owner role `eshobe`) exclusively, with no fallback; dev push behaviour is unchanged. See [srv1 deployment in README](./README.md#production-deployment-srv1--komodo).
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

## The platform control surface (`/api/platform/*`)

Every superadmin function and every fleet-wide report of this deployment is reachable
over the API, because the operator's console is not here: it is the «سایت‌ساز» section
of the sibling `cafe-restaurant-pos` super-admin console, holding a CMS address and one
`role: "platform"` key. Code in `src/endpoints/platformControl.ts` +
`src/platform/{report,events,snapshot}.ts` + `src/lib/platform-control.ts`; the full
contract is [`docs/platform-control-api.md`](./docs/platform-control-api.md).

- **Platform-admin session or a `role: "platform"` key, never a site key.** Same
  boundary as `provision-site` and `api-keys/issue`. A platform key's reach now includes
  reading any site's content through the snapshot export — which is not a new authority,
  because it could already issue itself a site key for any site. The boundary that
  matters is unchanged: a *site* key still reaches exactly one site.
- **Deliberately no Caddy carve-out.** These routes are called with the control plane's
  own `Host`, so they route there already; carving them onto customer domains would put
  "list every customer, export their content" one `curl` away from a shop's homepage.
  Same decision as `POST /api/payments/self-test`.
- **`domain` is not in the site patch** (`parseSitePatch` is an allowlist). Its one write
  path stays `PATCH /api/site/domain`, which resets `domainVerified` and re-checks
  uniqueness across primaries *and* aliases.
- **A report never scans an unbounded table.** Counts come from `payload.count`; money is
  summed row by row (no aggregate, and raw SQL stays in migrations), so every sum is
  windowed *and* capped by `ORDER_SCAN_CAP`, answering `revenueTruncated: true` rather
  than under-reporting. Sums stay per currency and in minor units — an order snapshots
  its own currency, so adding them together invents a number.
- **A snapshot carries content, never identity.** `id`/`site`/timestamps are stripped and
  the import sets `site` from the URL, the same rule as `forceApiKeySite`; `_status` is
  kept, because a restore that silently unpublished a live site is the worse outcome.
  Nested row ids survive, and the site's default locale is written first — that is what
  makes a second-locale write a translation and not a rewrite.
- **An import refuses another site's snapshot unless forced**: its relationship values are
  the source site's document ids. `media` is not in `SNAPSHOT_COLLECTIONS` at all — a JSON
  snapshot cannot carry the files, and pretending otherwise reads as a backup.
- The three staff endpoints the console needs (`payments/status`, `payments/self-test`,
  `storage-connections/self-test`) and the platform-wide CDN trio accept a platform key.
  **`payments/cancel` does not** — a refund moves a buyer's money.

## The SaaS control plane (superadmin)

The commercial half of the same surface — plans, subscriptions, invoices,
entitlements, quotas, plugins, themes, feature flags, webhooks, the audit trail and
platform settings. Code in `src/endpoints/platformSaas.ts` +
`src/endpoints/webhooks.ts` + `src/platform/{entitlements,saas-report,webhooks,audit,usage}.ts`
+ `src/lib/saas/*`; the contract is in the same
[`docs/platform-control-api.md`](./docs/platform-control-api.md), §5–8.

- **The admin panel is split by role, and that is navigation, not authority.**
  `src/admin/visibility.ts` hides the content collections from a platform admin and
  the control-plane collections from a customer's staff; `beforeDashboard` gives the
  operator a report instead of Payload's collection-count grid. `admin.hidden` is
  server-only and governs the nav and admin routes only — REST, GraphQL and the Local
  API are untouched, so it is never a boundary. Pair every `hidden` with the
  `access.read` that actually enforces it. `PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS=true`
  is the escape hatch, and `playwright.config.ts` sets it because the e2e fixture user
  is a platform admin editing content.
- **Endpoint order in `payload.config.ts` is load-bearing.** `platformSaasEndpoints`
  is spread **before** `platformControlEndpoints`, whose bare `/platform/sites/:id`
  would otherwise match the literal segment `quota` and answer 200 with a site
  document. A wrong-body 200 is worse than a 404 — every caller parses it. Pin any new
  `:id` sibling with an HTTP test (`tests/e2e/superadmin.e2e.spec.ts`).
- **Webhook lifecycle routes are collection endpoints**, on `Webhooks.endpoints`.
  Same rule as `/api/api-keys/issue`: a top-level path whose first segment is a
  collection slug never routes.
- **Blank and zero mean unlimited** (`normalizeLimit`). A plan saved with an empty
  `posts` box must not mean "zero posts allowed".
- **Quota enforcement defaults to `warn`.** Report the overage, block nobody;
  `enforce` is opt-in per site or platform-wide. A platform admin is never blocked —
  support happens over a customer's limit by definition. `pastDue` keeps a site
  serving; suspension is a separate deliberate action, and paying the invoice clears
  the flag automatically.
- **Derived money is unwritable.** Invoice `subtotal`/`tax`/`total` and line `amount`
  have `access.update: false` and are recomputed in `beforeChange`, so a posted total
  never existed. Paying an already-paid invoice is a 409, not an overwrite. One live
  subscription per site; `POST /platform/subscriptions` upserts.
- **Entitlement resolves in exactly one place** (`src/platform/entitlements.ts`):
  plan → subscription overrides → site overrides, non-null only. Plan features grant
  nothing unless the subscription is `serving`.
- **Theme templates are copied, not linked** — editing the catalogue must not repaint
  live customers — and `applyThemeTemplate` copies an explicit token allowlist, so a
  token added later is left alone rather than blanked.
- **Secrets leave the process once.** A webhook secret only in the `rotate-secret`
  response (admin session only); a plugin credential never. Build those responses
  field by field — a passthrough leaks the day somebody adds a field. `enc:v1:`
  ciphertext must not cross the wire either.
- **Nothing waits for a receiver.** `emitPlatformEvent` awaits the audit row and
  `void`s the webhook fan-out, same shape as `renderer-webhook`. Every attempt is
  recorded; `POST /api/webhooks/test` is a *real* delivery and goes through the same
  `recordDelivery`; a replay resends the stored bytes verbatim so the receiver
  recognises the delivery it missed. Signatures cover `<timestamp>.<body>`. A webhook
  naming a site hears only that site's events.
- **`audit-log`, `webhook-deliveries` and `usage-records` are append-only**:
  `create`/`update` are `() => false` and only `overrideAccess` service calls write
  them. `sanitizeChanges` redacts anything matching
  `/secret|password|token|credential|apikey|api_key|keyhash|privatekey|authorization/i`.
- **`PATCH /platform/settings` and `POST /api/webhooks/rotate-secret` refuse a
  platform key** — root policy and event-stream takeover both cost a human session,
  same reasoning as `payments/cancel`. **`GET /platform/self/entitlement` refuses
  everything but a site key** — it is the one route a customer's own app calls.

## Object storage (ArvanCloud)

Media is written to ArvanCloud Object Storage, configured by a superadmin — not by
environment variables. Design in `WAVE-6.md`, adapter in `src/storage/adapter.ts`,
plugin glue in `src/plugins/storage.ts`.

- **The connection lives in `storage-connections`, a platform-admin-only collection, and is
  deliberately *not* in the multi-tenant plugin's `collections` map** — it is shared
  infrastructure (like `ApiKeys`), not a site's own content. A tenant never sees or
  configures it; every site's files land in one bucket under `sites/<id>/media/`.
- **The secret key is never returned.** AES-256-GCM at rest (`enc:v1:…`,
  `src/storage/crypto.ts`), field access locked to `platformAdmin`, and an `afterRead` hook
  that blanks it unless `req.context[STORAGE_SECRET_READ_CONTEXT_KEY]` is set — the same
  three-layer pattern as payment gateways. `src/storage/connection.ts` is the only reader.
- **An empty secret field means "unchanged", never "delete".** `clearCredentials` is the
  explicit door for wiping it.
- **Only one connection may be `enabled`** (`assertSingleEnabledConnection`); the resolver
  reads "the enabled row", not a list. `assertConnectionUsable` refuses to enable a
  connection with no readable key.
- **The plugin runs with `disableLocalStorage: false`**, so Payload also writes to
  `Media.staticDir`. With no enabled connection the adapter no-ops on upload and its static
  handler returns `undefined` so Payload serves from disk (the dev default); with one
  enabled, files also go to ArvanCloud and are served from there.
- ArvanCloud specifics that must stay: `forcePathStyle` on, `region: 'default'`, no ACL
  (the bucket stays private; everything is served through `/api/media/file/*`). The
  endpoint default is `https://s3.ir-thr-at1.arvanstorage.ir`.
- Rotating `OBJECT_STORAGE_KEY` or `PAYLOAD_SECRET` invalidates the stored secret key with
  no re-encryption job; re-enter it in the admin UI.

## srv1 / Komodo deployment invariants

- Deploy only `docker-compose.srv1.yml`, never the generic `docker-compose.prod.yml`/Caddy stack on this shared host. OpenLiteSpeed owns 80/443; web publishes **127.0.0.1:3001 only**.
- Keep project **eshobe-cms**, shared image **eshobe-cms-web**, and volume keys **pgdata / media_uploads** unchanged. No `down -v` in production. Keep memory, swap, PID and `no-new-privileges` limits on every service, including the one-shot migrator.
- `web.depends_on.migrate.condition` must remain **service_completed_successfully**. `migrate` has `restart: 'no'`; failure must block a new web start. This is not a supervisor for already-running web containers: stop the old web process first for crash-loop recovery/maintenance.
- All Compose environment values are `${VAR}` references and each service has an explicit allowlist. No `env_file` on web: it would leak the privileged migration credential. No database credentials in Docker build args, image layers, or source.
- The shared image keeps a production-dependencies-only tool tree under `/app/migrator` (dev deps and next's optional `@next/swc`/`@playwright/test` are pruned; sharp's platform binaries must stay — it resolves them at import time). Standalone `node server.js` does not contain the CLI by itself. This costs image size but guarantees one app/migrator build. `scripts/migrate.ts` uses Payload's transactional runner, rejects push-created databases and destructive drop flags, never starts jobs, and exits non-zero on failure.
- The database runs the **owner-only** model: `eshobe_app` owns everything in schema `public`, there are no grants and no default ACLs. Never introduce a GRANT-based model next to it. After migrations, the one-shot reassigns all public tables/sequences/views/types to `APP_DATABASE_ROLE` (never hardcoded or guessed — derived from `DATABASE_URL` only when that env is present) and then a verification gate fails the step (so `web` never starts) if anything in `public` is not owned by / accessible to the runtime role. This also reassigns the pre-existing enums, removing the original `ALTER TYPE` root cause. Never solve ownership errors by elevating the runtime role.
- Komodo logs expanded Compose config **in plaintext**, including `MIGRATE_DATABASE_URL`. Include it in the credential rotation list; restrict log access and do not paste config/env dumps into tickets. Changing `POSTGRES_PASSWORD` does not rotate an existing database role automatically.

## CI and publishing are both automatic

`.github/workflows/ci.yml` runs on **every pull request** (plus
`workflow_dispatch` and `workflow_call`). It was manual-only once; that meant
nothing checked a branch unless somebody remembered to dispatch it, and the only
thing in front of a published image was lint/typecheck/build. Every suite the
repo owns is a job now: `lint`,
`typecheck`, `build`, `docker-build` (image + `tests/deployment/compose-smoke.sh`),
`test-int` (Vitest + the ownership replay) and `test-e2e` (Playwright).

There is deliberately **no `push: branches: [main]` trigger**: a merge starts
`publish.yml`, whose gate *is* this workflow via `workflow_call`, so `main` is
covered on every merge and adding the push trigger would just run the whole
suite twice on the same commit.

**`ci-success` is the job to require in branch protection**, not the six
individually. It `needs` all of them and fails on any non-`success` result, so a
cancelled or skipped job is not a pass. `tests/int/ci-workflows.int.spec.ts`
asserts its `needs` list equals every other job in the file — add a job and that
test fails until you add it to the gate too.

`.github/workflows/publish.yml` still runs on every push to `main`, and must:
**that is what deployment consumes.** It pushes `ghcr.io/<owner>/<repo>:latest`
(plus the long sha tag), and the srv1 Komodo stack pulls exactly that image
through the `ghcr-mirror.liara.ir` cache (`docker-compose.srv1.yml` — the tag is
literal because Komodo resolves the reference without variable interpolation).
Making it manual would mean a merge produces no image and Komodo silently keeps
deploying a stale `latest`. Its gate is now `uses: ./.github/workflows/ci.yml`
rather than a copied-out `gates` job: one definition of "the tests pass", shared
by the PR check and the deploy.

### Publishing is deploying: Coolify pulls by itself

`publish.yml` ends at the registry. Coolify watches
`ghcr.io/<owner>/<repo>:latest` and rolls the service on its own schedule —
**there is no deploy job, no Coolify API token and no webhook in this repo**, and
an earlier attempt to add one (a `curl` to a hardcoded service UUID) has been
removed. `tests/int/ci-workflows.int.spec.ts` asserts `publish.yml` has exactly
the two jobs `ci` and `docker-publish`, so a deploy job reappearing is a visible
decision rather than a quiet one.

The consequence is the thing to keep in mind: **nobody presses a button between a
green merge and production.** `ci` is the last gate there is, which is why
`docker-publish` needs the whole suite and not a subset.

Two invariants hold the handoff together:

- **`:latest` must keep being published on `main`** (and the long-sha tag
  alongside it, which is what makes a running container traceable to a commit
  once `:latest` has moved). Coolify has nothing else to watch.
- **The GHCR package must stay PUBLIC.** srv1 pulls through the
  `ghcr-mirror.liara.ir` pull-through cache because ghcr.io itself is DPI-blocked
  there, and the mirror holds no upstream credentials — a private package returns
  404 through it.

After pushing, the workflow pulls each published tag back with
`docker buildx imagetools inspect` and fails if the digest is not the one it just
pushed. `docker/build-push-action` reporting success means the upload finished,
not that GHCR serves a manifest Coolify can pull; with no human in the loop, a
half-propagated or hijacked tag would otherwise be discovered by Coolify pulling
it into production. A job summary records the digest, commit and tags.


## Commands

```bash
pnpm dev                     # Next + Payload
pnpm payload migrate:create  # after config changes, before deploy
pnpm payload migrate:status  # read status via DATABASE_URL
pnpm migrate                 # one-shot, requires MIGRATE_DATABASE_URL (never web)
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

## Deployable themes (Wave 11)

Externally developed themes, hosted on GitHub, built against `docs/THEME_API.md` and deployed to the operator's own Coolify. Design and rationale: `docs/theme-deployments.md`.

- Four collections, split by who owns the row. **Operator catalogue, platform-wide:** `theme-packages` (a repo + its synced manifest) and `deploy-targets` (a Coolify server + its token). **Per-site, multi-tenant plugin:** `site-deployments` (one row per attempt, the audit trail) and `site-theme-settings` (the tenant's answers to the manifest's `env` questions). The catalogue pair is in the `platformWide` allowlist in `tests/int/store.int.spec.ts`; the tenant pair must never be.
- **The manifest is the contract.** `eshobe.theme.json` in the repo, parsed by `parseThemeManifest` in `src/lib/deploy/manifest.ts`, which refuses rather than coerces — a newer `contractVersion`, a tenant variable colliding with a platform one, an unknown build pack, a non-https preview. A package cannot be published until a sync has stored a valid manifest, and cannot deploy until it is published. `siteTypes` is checked **twice**: the manifest's list (the author's capability claim) and the row's (the operator's narrowing).
- **Three domain modes**, and they are not interchangeable. `preview` puts the theme on the target's wildcard and touches no customer DNS. `edge` keeps the customer's DNS on Caddy, which proxies *pages only* to the theme — `/api/*` stays on `web:3000`, so checkout, forms and media keep working and `/admin` stays a 404. `direct` points customer DNS at Coolify and is refused unless the manifest declares `proxiesApi`, because otherwise it silently takes checkout down. Anything but `preview` requires `domainVerified`.
- The Caddy map in `theme-routes.caddy` is generated by `scripts/render-theme-routes.mjs` from `GET /api/platform/routing`. It is **committed even though it is generated and empty by default** — a missing `import` is a Caddy that will not boot. The script writes atomically and exits non-zero *without touching the file* on any failure; a truncated map takes every themed site offline at once. The routing table emits only `live` + `edge` rows, only verified aliases, and drops a row whose `domain` no longer matches the site's (the app's vhost would 404 it — falling through to the built-in renderer is the better failure).
- **Secrets.** Coolify tokens (`deploy-targets.apiToken`) and tenant secret answers (`site-theme-settings.secretValues`) use `src/lib/deploy/crypto.ts` — a fifth per-domain module, deliberately not reusing the platform one, so a leak of one context cannot decrypt another. Blank on save means *unchanged*, never delete; clearing is an explicit checkbox. The same rule as `Plugins.ts` and `storage-connections`.
- Platform env vars are written **after** the tenant's in `buildEnvironment`, because Coolify's bulk endpoint takes the last value for a key — a second barrier behind the manifest's refusal to declare them. `ESHOBE_API_KEY` and `ESHOBE_REVALIDATE_SECRET` are runtime-only (`isBuildTime: false`): a secret baked into a build layer outlives its rotation.
- Deploys run in the **jobs queue** (`advanceDeployments`, the first real task in `jobs.tasks`), never in the request. A Coolify build takes minutes; the create endpoint answers `202` with a row id. Status moves through `canTransition` in `src/lib/deploy/status.ts` — illegal moves are logged and dropped, not written, so a late retry cannot overwrite a terminal state.
- `sites.renderedBy` (`platform` | `deployment`) is the switch, and reverting it to `platform` is the escape hatch that makes the feature safe to try on a live customer. `is_auto_deploy_enabled` is **false** on every Coolify app: redeploys are driven from the CMS, partly because Coolify's API-created webhooks are unreliable (coollabsio/coolify#4435).
- **Admin surface.** `theme-packages` and `deploy-targets` each carry a `ui` field as their *first* field (sync/publish, self-test) — the button belongs above the read-only fields it rewrites. The per-site console is a document view on `sites` at `/deployment`. A document tab's `href` is **not** derived from the view's `path`: `DefaultDocumentTab` reads `tab.href` and nothing else, so omitting it yields a tab pointing at the document root while the view still renders fine at its own URL — silent, and only visible by reading the emitted anchor. `DocumentTabLink` joins them as `docPath + href`, so the value is a bare suffix (`/deployment`), never absolute. Pinned in `tests/int/deploy-admin.int.spec.ts`.
- The renderer webhook signs the **raw body only**, not `<timestamp>.<body>` like the platform webhooks — `docs/THEME_API.md` §17 is already published and deployed themes verify it that way. Changing it would fail silently: renderers would reject every notice and serve stale pages. That is a v2 change, made in the doc first.

## Working style

- Read `PLAN.md` before starting a wave; deployment specifics live in `WAVE-4.md` (domains, TLS), `WAVE-6.md` (object storage, SEO, jobs, backups), `WAVE-7.md` (the store and why `@payloadcms/plugin-ecommerce` is not used), `WAVE-9.md` (the headless contract), `WAVE-10.md` (Iranian payment gateways) and `docs/theme-deployments.md` (externally hosted themes on Coolify). Waves are tracked as GitHub issues #1–#9 under #10.
- Wave 1 gates everything: do not start Wave 2 until its cross-tenant and draft-leak tests pass.
- When adding a collection, add its cross-tenant leak test in the same change.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
