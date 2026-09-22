# Deployable themes — from a GitHub repo to a running site on Coolify

**Status: design / RFC.** Nothing here is implemented yet. This is the answer to one
question: *a theme was built against [`docs/THEME_API.md`](./THEME_API.md) and lives in a
GitHub repository — what does the super-admin's theme section need to become so that a
customer picks that theme, and the platform deploys it on Coolify, attaches the customer's
domain, and runs it?*

---

## 1. The thing that is missing today

The CMS already has **two** theme concepts and neither of them is an app:

| What exists | Slug | What it holds |
|---|---|---|
| Per-site tokens | `theme` | The colours/radius/line-height **one site** renders with. |
| The catalogue of presets | `theme-templates` | Token sets the operator offers; `applyThemeTemplate` copies them onto a site. |

Both describe *paint*. A headless theme from GitHub is *a program*: a repo, a branch, a
build, a port, environment variables, a domain, a lifecycle, logs. Trying to squeeze it
into `theme-templates` would repeat exactly the mistake that collection's header warns
about — conflating a catalogue with a live artefact.

So: **a third collection, not a field on the second.**

```
theme-templates   →  tokens only            (already exists, unchanged)
theme-packages    →  a deployable theme     (NEW — the GitHub repo + build contract)
site-deployments  →  one running instance   (NEW — site × package on a Coolify app)
deploy-targets    →  a Coolify connection   (NEW — URL, token, server, project)
```

A `theme-package` may *reference* a `theme-template` as its default token set, so picking
"فروشگاهی تیره" still seeds `theme` on provision. The two stay separable: the deployed app
reads tokens at runtime from `GET /api/site`, so changing tokens never triggers a rebuild —
that property from §9 of the Theme API is the whole reason this split works.

---

## 2. The theme repo declares itself: `eshobe.theme.json`

The super-admin should not hand-type a build command. The theme repo carries a manifest at
its root, and the CMS reads it over the GitHub API when the operator registers or syncs the
package. Hand-entry stays possible as an override, but the manifest is the source of truth.

```jsonc
{
  "name": "Bazaar Store",
  "nameFa": "بازار",
  "key": "bazaar-store",
  "contractVersion": 1,              // MUST be <= the platform's, else registration fails
  "siteTypes": ["store"],            // gates which sites may pick it
  "locales": ["fa", "en"],
  "build": {
    "pack": "nixpacks",              // nixpacks | dockerfile | static
    "baseDirectory": "/",
    "installCommand": "pnpm i --frozen-lockfile",
    "buildCommand": "pnpm build",
    "startCommand": "pnpm start",
    "port": 3000,
    "healthCheckPath": "/api/health"
  },
  "env": [
    { "key": "ESHOBE_CMS_URL",    "source": "platform" },
    { "key": "ESHOBE_SITE_DOMAIN","source": "platform" },
    { "key": "ESHOBE_API_KEY",    "source": "platform", "secret": true },
    { "key": "REVALIDATE_SECRET", "source": "platform", "secret": true },
    { "key": "MAP_API_KEY",       "source": "tenant", "required": false,
      "labelFa": "کلید نقشه", "help": "اختیاری — برای بلوک نقشه" }
  ],
  "capabilities": { "checkout": true, "search": true, "blog": true },
  "preview": "https://raw.githubusercontent.com/…/preview.png"
}
```

Three rules that make this safe:

- **`source: "platform"` variables are written by the CMS and are not editable by the
  tenant.** `ESHOBE_API_KEY` in particular is minted by the platform, not pasted by anyone.
- **`source: "tenant"` variables become a small generated form** in the site's admin
  ("تنظیمات پوسته"). They are the only free text a customer can inject into a build
  environment, and they are stored encrypted (`encryptPlatformSecret`, as
  `payment-gateways` credentials already are) when `secret: true`.
- **`contractVersion` is checked on registration and again on every deploy.** The Theme API
  doc already promises "bump = breaking change"; this is where that promise is enforced
  instead of being a comment.

---

## 3. The four new collections

### 3.1 `deploy-targets` — where the platform can run things

Platform-admin only, hidden from customers, one row per Coolify instance/server pair.

| Field | Notes |
|---|---|
| `name`, `key` | «سرور اصلی — تهران» |
| `provider` | `coolify` today; the field exists so a second provider is an enum value, not a rewrite |
| `baseUrl` | `https://coolify.example.com` |
| `apiToken` | AES-encrypted at rest, write-only field, blanked in `afterRead` — same treatment as `payment-gateways.credential` |
| `serverUuid`, `projectUuid`, `environmentName` | Coolify placement |
| `gitSource` | `public` \| `githubApp` + `githubAppUuid` \| `deployKey` + `privateKeyUuid` |
| `wildcardDomain` | e.g. `*.sites.eshobe.ir` — used for a pre-DNS preview URL |
| `capacity`, `active` | Lets the operator drain a box without deleting it |
| `lastCheckAt/Ok` | Filled by a `POST /api/platform/deploy-targets/:id/self-test`, mirroring the gateway/storage self-test pattern already in the codebase |

### 3.2 `theme-packages` — the catalogue entry

| Field | Notes |
|---|---|
| `name`, `key`, `description`, `preview` | Same shape as `theme-templates`, so the picker UI is one component |
| `repository` | `hamidnoshady/bazaar-store` (owner/name, not a URL — the provider is a field) |
| `provider` | `github` |
| `visibility` | `public` \| `private` (decides which Coolify create endpoint is used) |
| `defaultRef` | `main`, or a tag |
| `pinnedCommit` | Optional; when set, every new deploy pins `git_commit_sha` |
| `manifest` | The JSON read from the repo, stored verbatim + `manifestSyncedAt` |
| `contractVersion`, `build*`, `envSchema`, `siteTypes`, `capabilities` | Projected out of the manifest into real fields so queries/validation work |
| `themeTemplate` | Relationship → `theme-templates`; the tokens applied when a site adopts this package |
| `status` | `draft` \| `published` \| `deprecated`. Only `published` appears in a customer picker; `deprecated` keeps existing deployments running but hides it from new ones |
| `requiredFeature` | A `feature-flags`/entitlement key, so "premium themes" is a plan matter and not a new mechanism |
| `defaultTarget` | Relationship → `deploy-targets` |

Two operator actions on the row: **«همگام‌سازی از گیت‌هاب»** (re-read the manifest, diff it,
show what changed) and **«انتشار»** (draft → published, refused if the manifest is missing,
the contract version is too high, or no deploy target is set).

### 3.3 `site-deployments` — one running instance

This is the row that makes the whole thing debuggable. One per (site, package) — a site has
at most one `live` deployment, but history is kept.

```
site, themePackage, target
appUuid                  // Coolify application uuid
ref, commitSha           // exactly what is running
domain                   // the hostname Coolify serves
status: queued | creating | configuring | building | live | failed | stopped | removed
lastDeploymentUuid, lastError, logTail
apiKey                   // relationship -> api-keys (the site key this app uses)
createdAt / deployedAt
```

`status` is written only by the deploy job. Nothing else may set it — a status field that
two writers can touch is a status field nobody can trust.

### 3.4 `site-theme-settings`

The tenant's answers to the manifest's `source: "tenant"` variables. Could be a group on
`site-deployments`; a separate doc is better because re-deploying should not rewrite the
customer's own values, and because field-level access differs (tenant may edit these; they
may not edit `appUuid`).

---

## 4. What happens when a customer picks the theme

The picker posts one request. Everything after it is a **job**, not an HTTP handler —
`payload.config.ts` already configures the jobs queue with `tasks: []`, and this is the
first real task it should carry. A Coolify build takes minutes; an endpoint that waits is an
endpoint that times out behind Caddy.

```http
POST /api/platform/sites/:id/deployment
{ "package": "bazaar-store", "ref": "v1.3.0", "target": "tehran-1" }
→ 202 { ok: true, deployment: "<id>", status: "queued" }
```

Then the task, step by step:

**1 — Refuse early.** Site is `active`; package is `published`; `siteTypes` includes the
site's type; `contractVersion` ≤ platform's; the plan entitles the site to this package
(`requiredFeature`); the site has a `domain` and, if the deployment is to serve it,
`domainVerified`. Every refusal is a Persian message on the deployment row, not a 500.

**2 — Mint the site's runtime credential.** Reuse the existing issue path
(`/api/api-keys/issue`, `role: "site"`, `siteId`). The raw key is returned exactly once —
that once is here, and it goes straight into Coolify's env. The CMS stores only the
`api-keys` relationship, never the plaintext. Rotating a theme's key becomes: issue new,
patch env, redeploy, revoke old.

**3 — Create the Coolify application.**

```http
POST {baseUrl}/api/v1/applications/public          # or /private-github-app
Authorization: Bearer <decrypted target token>

{
  "project_uuid": "…", "server_uuid": "…", "environment_name": "production",
  "git_repository": "https://github.com/hamidnoshady/bazaar-store",
  "git_branch": "v1.3.0",
  "build_pack": "nixpacks",
  "ports_exposes": "3000",
  "name": "acme-ir-bazaar-store",
  "domains": "https://acme.ir",
  "is_force_https_enabled": true,
  "is_auto_deploy_enabled": false,     // see §7 — upgrades are opt-in per site
  "instant_deploy": false,
  "health_check_enabled": true, "health_check_path": "/api/health"
}
→ { "uuid": "<appUuid>" }
```

Persist `appUuid` **before** anything else can fail. An orphaned Coolify app with no row in
the CMS is the one state that costs a human being an afternoon.

**4 — Write the environment.**

```http
PATCH {baseUrl}/api/v1/applications/{appUuid}/envs/bulk
{ "data": [
  { "key": "ESHOBE_CMS_URL",     "value": "https://cms.eshobe.ir" },
  { "key": "ESHOBE_SITE_DOMAIN", "value": "acme.ir" },
  { "key": "ESHOBE_API_KEY",     "value": "eshobe_live_…", "is_preview": false },
  { "key": "ESHOBE_DEFAULT_LOCALE", "value": "fa" },
  { "key": "ESHOBE_LOCALES",     "value": "fa,en" },
  { "key": "REVALIDATE_SECRET",  "value": "<per-deployment random>" },
  … tenant vars, decrypted at this moment and never logged …
]}
```

**5 — Deploy and follow it.** `POST /applications/{appUuid}/start`, then poll
`GET /deployments/{uuid}` on a backoff, writing `status` and a truncated `logTail` onto the
row so the admin view can show progress without giving anyone the Coolify token.

**6 — Domain.** See §5 — this is the part with an actual architectural decision in it.

**7 — Flip the site.** On a healthy first response: `site.renderedBy = "deployment"`,
`site.activeDeployment = <id>`, apply the package's `themeTemplate` tokens via the existing
`applyThemeTemplate`, `emitPlatformEvent('site.deployment.live')` (so `/api/platform/events`
and the webhook fan-out already carry it), and `recordAudit`.

On failure: status `failed`, the message in Persian, the site untouched — it keeps being
served by the built-in renderer. **A failed theme deploy must never take a live site down.**

---

## 5. The domain, and the one thing that will bite

Today `acme.ir` resolves to the Caddy box, which reverse-proxies `web:3000` and gets its
certificate through on-demand TLS gated by `/api/domain-check`. If the theme app now owns
`acme.ir` on the Coolify server, the customer domain no longer points at Caddy — and the
Caddyfile's customer-domain vhost is not decoration. It carves out the API paths a
storefront genuinely needs on its own origin: `/api/checkout*`, `/api/form-submissions`,
`/api/payments/methods`, `/api/site`, `/api/media/file/*`, `/api/site/domain`. Move the
domain and those 404 — the contact form and, worse, checkout stop working.

Three ways out. Pick one deliberately.

### Option A — Caddy stays the edge, Coolify is an upstream *(recommended)*

DNS keeps pointing at the Caddy box. The customer vhost gets one more rule: everything that
is **not** a carved-out API path proxies to the theme app instead of `web:3000`.

```caddyfile
# … existing @checkout / @form_submissions / @site_descriptor / @media_files blocks …

handle {
    reverse_proxy {http.regexp.upstream} {   # from a small map, or a snippet per site
        # theme app for this Host, e.g. 10.0.0.12:3000
    }
}
```

The upstream table must be generated, not hand-written — a `GET /api/platform/routing` that
emits a Caddy JSON/map file, or Caddy's `dynamic upstreams` module querying the CMS. Since
Caddy stays the edge: on-demand TLS keeps working unchanged, `/api/domain-check` keeps being
the single authority on which hostnames may get a certificate, alias 308s keep working, and
the theme never has to think about `/api/*` at all. **This is the least new surface and the
fewest broken invariants.**

### Option B — Coolify owns the domain, the theme proxies `/api/*` back

DNS points at the Coolify server, Traefik/Caddy there terminates TLS, and the theme repo is
*required by contract* to proxy the reserved API paths to `ESHOBE_CMS_URL` **preserving the
`Host` header** (so tenant resolution still works). That requirement becomes a new section
in `THEME_API.md` and a line in the manifest (`"proxiesApi": true`), plus a verification
step in the deploy job that actually fetches `https://acme.ir/api/site` and checks the
returned `domain` matches. Simpler infra, but it makes every theme author responsible for a
security-relevant proxy, and a theme that gets it wrong silently breaks checkout.

### Option C — split hostnames

`acme.ir` → theme app, `cms.acme.ir` or the control-plane host → CMS, with the theme calling
the CMS cross-origin. Requires the domain in `API_CORS_ORIGINS`, exposes tenant traffic to
CORS/preflight cost, and puts a second hostname in front of the customer. Fine for a POS-ish
headless client; poor for a storefront that must POST checkout same-origin.

**Either way the CMS must know which mode a site is in.** Add `sites.renderedBy:
"platform" | "deployment"` and have `/api/domain-check` and the alias-redirect logic consult
it, so a site whose traffic no longer arrives at Caddy does not sit there waiting to issue a
certificate nobody will ever request.

Before DNS is cut over, give the operator a preview: `bazaar-acme.sites.eshobe.ir` from the
target's `wildcardDomain`, added as a second value in Coolify's `domains`. The customer sees
their theme running on their content before changing a single DNS record.

---

## 6. Content changes have to reach the new renderer

`notifyRenderers()` posts to a single global `REVALIDATE_WEBHOOK_URL`. With N deployed
themes that is wrong by construction: one deployment's URL, HMAC'd with the deployment's own
secret, is what each site needs.

Change it to resolve targets **per site** — the `site-deployments` row for that site
contributes `https://acme.ir/api/revalidate` plus its `REVALIDATE_SECRET` — and keep the env
var as the global fallback. The signature scheme (`x-eshobe-signature: sha256=…` over the
raw body) and the 3s fire-and-forget stay exactly as documented; only target resolution
changes. `THEME_API.md` then documents `/api/revalidate` as a route a deployable theme
**must** implement, and the deploy job's health check can verify it responds 401 to an
unsigned request — a theme that skips signature verification should fail to go live.

---

## 7. Upgrades, suspension, teardown

- **Version pinning is per site.** `is_auto_deploy_enabled: false` on create; a new tag on
  the theme repo shows up in the admin as "نسخهٔ جدید موجود است" on every deployment using
  that package, and the operator (or the customer, if the plan allows) presses redeploy.
  Auto-deploying twenty customer storefronts because a theme author pushed to `main` is a
  fleet-wide outage waiting for its Tuesday.
- **Suspension already has semantics** — `sites.status: suspended|archived` serves the
  holding page. A deployment must honour it: on suspend, `POST /applications/{uuid}/stop`
  and let Caddy fall back to `web:3000`, which renders `SiteHolding`. Stop, never delete;
  the same reasoning as "do not delete a site".
- **Switching themes** creates a *new* `site-deployments` row, deploys it on the preview
  hostname, health-checks it, then moves the domain and stops the old app. Delete the old
  app only after a grace period, and revoke its API key at the same moment.
- **Rollback is redeploy of the previous row's `commitSha`**, which is exactly why that
  column exists.

---

## 8. Security notes worth writing down before coding

1. **Tenants never name a repository.** They pick from `theme-packages` rows a platform
   admin created. A field where a customer types a Git URL is a "build and run arbitrary
   code on our server" field.
2. **The Coolify token is deployment root.** Encrypt it like the reseller key and the
   gateway credentials, blank it in `afterRead`, and never surface Coolify's own responses
   verbatim to a tenant — the log tail shown in the admin must be truncated and scrubbed of
   `Authorization` / env values.
3. **One site key per deployment**, scoped to that site, revoked when the deployment dies.
   Never reuse a platform key — §1 of `platform-control-api.md` is explicit that a platform
   key is the deployment's root credential.
4. **Tenant env values are attacker-controlled strings** heading into a build environment.
   Validate against the manifest's declared keys, reject anything not declared, cap length,
   and never interpolate them into a shell command.
5. **The manifest is fetched from GitHub over HTTPS with a pinned ref**, parsed with a
   schema, and size-capped. A 50MB "manifest" should cost one rejected request.

---

## 9. What the super-admin actually sees

Under the existing `PLATFORM_GROUPS.extensions` group, the theme section becomes two
entries plus one view:

- **«پوسته‌های آماده»** — `theme-templates`, unchanged. Colours.
- **«پوسته‌های نصب‌شدنی»** — `theme-packages`. Register from a repo, sync the manifest,
  preview image, which site types, which plan, publish/deprecate, default deploy target.
- **«سرورهای استقرار»** — `deploy-targets`, with a self-test button.
- On each **site**: a "پوسته و استقرار" tab showing the current deployment, its status,
  commit, domain mode, a log tail, and the three buttons that matter — «استقرار مجدد»،
  «بازگشت به نسخهٔ قبل»، «بازگشت به رندرر داخلی».

And the API surface, following the `/api/platform/*` conventions already established:

| Route | Purpose |
|---|---|
| `GET/POST /api/platform/theme-packages` | Catalogue CRUD |
| `POST /api/platform/theme-packages/:id/sync` | Re-read `eshobe.theme.json` |
| `GET/POST /api/platform/deploy-targets` + `/self-test` | Coolify connections |
| `POST /api/platform/sites/:id/deployment` | Adopt a theme → 202 + job |
| `GET /api/platform/sites/:id/deployment` | Status, commit, logs |
| `POST /api/platform/sites/:id/deployment/redeploy` \| `/stop` \| `/rollback` | Lifecycle |

Platform-admin session or `role: "platform"` key, same `isPlatformAdminOrPlatformKey`
boundary as everything else on that prefix — which also means the sibling
`cafe-restaurant-pos` console gets the whole feature without opening `/admin`.

---

## 10. Suggested build order

1. `deploy-targets` + encrypted token + self-test. Nothing else works without a proven
   connection.
2. `theme-packages` + manifest fetch/validate + the `eshobe.theme.json` spec added to
   `THEME_API.md`.
3. The Coolify client (`src/deploy/coolify.ts`): create, envs/bulk, start, deployment
   status, stop, delete. Pure-ish, unit-tested against recorded fixtures.
4. `site-deployments` + the `deploySiteTheme` job + status machine.
5. Domain mode: `sites.renderedBy`, `/api/domain-check` awareness, the Caddy upstream map
   (Option A).
6. Per-site revalidation targets in `notifyRenderers`.
7. Admin views and the `/api/platform/*` routes.
8. Rollback, version-available notice, suspension wiring.

Steps 1–4 are demonstrable on a wildcard preview hostname with no customer DNS involved at
all, which makes step 5 — the only genuinely risky one — something you switch on for one
site at a time.
