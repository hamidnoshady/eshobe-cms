# Deployable themes — from a GitHub repo to a running site on Coolify

**Status: implemented (Wave 11).** This document describes the system as it runs. The
author's side of the contract — `eshobe.theme.json`, the environment a theme receives,
the revalidation webhook — is [`docs/THEME_API.md`](./THEME_API.md) §17 and §17b. The
HTTP surface is [`docs/platform-control-api.md`](./platform-control-api.md) §9. Immutable
GHCR builds, placement layouts, CI registration, promotion, and digest rollback are documented
in [`docs/theme-artifacts.md`](./theme-artifacts.md).

A theme built against the Theme API lives in its own GitHub repository. The operator
registers it, assigns it to a site, deploys a **preview** on the operator's preview Coolify
project, verifies the customer's domain, then **publishes** on the production Coolify project.
The normal product flow no longer chooses between Caddy `edge` and Coolify `direct` — production
is Coolify-first. Legacy `edge` remains behind `ESHOBE_LEGACY_CADDY_EDGE=1` for existing sites.

---

## 0. The short version

Eight tables exist so that each thing has one owner. You do not need to think about most of
them. A site goes live in six steps, and the **«آمادگی پوسته»** checklist at the top of the
site's «استقرار پوسته» tab tells you which one is open (`GET …/deployment/readiness`):

| # | Step | Who | Where |
|---|---|---|---|
| 1 | Register the theme repo, **sync**, **publish** | operator | `theme-packages` |
| 2 | CI builds the image and registers its digest (registry strategy; needs three repo secrets, see `theme-artifacts.md`) | automatic | `theme-artifacts` |
| 3 | **Assign** the theme to the site | operator | site → «استقرار پوسته» |
| 4 | Choose the theme's pages/categories and fill its variables | customer or operator | site → «تنظیمات پوسته» |
| 5 | **Deploy preview**, look at it | operator | site → «استقرار پوسته» |
| 6 | Verify DNS, then **publish** to the domain | operator | site → «استقرار پوسته» |

Steps 4 and 6 can be done in either order; a preview never needs a verified domain. If
something looks wrong on the live site, «بازگشت به رندرکنندهٔ داخلی» (revert) always works.
Everything else in this document is what those six steps do underneath.

A page the theme shows is **never found by its slug** once the customer has chosen it in step
4 — the theme's URLs are fixed, the content behind them is bound. See `THEME_API.md`
(«How a theme should consume bindings»).

---

## 1. Who decides what

Deployable themes are **operator-managed**. Which package a site runs, on which server, in
which domain mode, is decided by platform staff — the «استقرار پوسته» tab on a site, or
`/api/platform/sites/:id/deployment*` from the sibling console. There is no customer
theme picker and no customer deploy button, and that is a product decision rather than a
missing feature: a deploy puts third-party code in front of a customer's domain, and the
safety checks around it (verified domain, `proxiesApi`, a health check before anything
switches) are operator judgement calls.

A customer's staff decide exactly one thing: the answers to the variables the theme asked
*them* for (§8). They never name a repository, a package, a server or a mode.

---

## 2. The pieces

| Concept | Slug | Owner | What it holds |
|---|---|---|---|
| Per-site tokens | `theme` | site | Colours/radius — unchanged by any of this. |
| Design defaults | `theme-packages.designDefaults` | platform | Copied only when a site first adopts a different theme or an operator explicitly applies defaults. |
| **Deployable theme** | `theme-packages` | platform | Repository visibility, strategy, manifest, synced/pinned commit, and optional allowed GHCR repository/visibility. |
| **Immutable build** | `theme-artifacts` | platform | One commit's verified image repository + digest, workflow provenance, and build state. |
| **Coolify connection** | `deploy-targets` | platform | Encrypted API token, lane placements, Git capabilities, and registry capabilities. |
| **One attempt** | `site-deployments` | site | Auditable history: status, lane/mode, hostnames, ref/commit, log tail. |
| **Coolify identity** | `theme-bindings` | site | One row per (site × package × lane): `appUuid`, pinned project/server, app name. |
| **Intent** | `sites.assignedThemePackage` | site | Which published package is assigned before any container exists. |
| **Tenant answers** | `site-theme-settings` | site | The customer's values for the manifest's `source: "tenant"` variables (one document per site). |

`theme-packages` and `deploy-targets` are platform-wide (the documented exception to the
multi-tenant registration rule, and in `platformWide` in `tests/int/store.int.spec.ts`).
`theme-bindings`, `site-deployments` and `site-theme-settings` are registered with the multi-tenant plugin.

`sites.renderedBy` (`platform` | `deployment`) and `sites.activeDeployment` say who serves
the customer's domain. Both are written only by the deploy service (field access denies
every caller, including platform admins, so a stale admin form cannot put an old value
back).

---

## 3. Registering a theme

1. Create a `theme-packages` row: repository (`owner/name`), visibility, default ref, and
   optionally a **pinned commit** (every new deploy then builds exactly that commit),
   a default target, a `requiredFeature` (a plan feature key) and design defaults copied on adoption.
2. **«همگام‌سازی از گیت‌هاب»** (`POST /api/platform/theme-packages/:id/sync`) reads
   `eshobe.theme.json` at the ref, validates it (`parseThemeManifest` refuses rather than
   coerces), projects it into read-only fields, and stores `syncedCommitSha` — the commit
   the ref pointed at. A failed sync keeps the previous manifest and records `syncError`.
   Editing `defaultRef` by hand afterwards clears `syncedCommitSha` until the next sync.
3. **«انتشار»** (`POST …/publish`, admin session only) refuses a package with no manifest,
   no contract version, or no active deploy target.
4. **(اختیاری) وب‌هوک گیت‌هاب** — `POST /api/platform/theme-packages/github-webhook` on the
   control-plane host only. Configure GitHub `push` events with the same secret as
   `GITHUB_THEME_WEBHOOK_SECRET`. When a push lands on a package's `defaultRef`, the CMS
   re-syncs that package (same rules as manual sync). **No site is redeployed**; operators
   only see «نسخهٔ جدید موجود است» until they preview or redeploy explicitly. Duplicate
   `X-GitHub-Delivery` ids are ignored.

Only a published package can be deployed. `siteTypes` is checked twice: the manifest's list
(the author's claim) and the row's (the operator's narrowing).

A `deploy-targets` row needs its self-test (`POST /api/deploy-targets/self-test`) green
before a deploy is worth trying; its token is encrypted with `src/lib/deploy/crypto.ts`,
masked on read, and blank-on-save means unchanged.

---

## 4. Lanes (preview and production)

| Lane | Coolify project | Hostnames | Effect on live site |
|---|---|---|---|
| `preview` | `deploy-targets.previewProjectUuid` | Wildcard preview only | Rehearsal — does not change `renderedBy` |
| `production` | `deploy-targets.productionProjectUuid` | Verified primary domain on Coolify | After health check, sets `activeDeployment` + `renderedBy: deployment` |

API and admin UI prefer `lane`. Older callers may still send `domainMode=preview` or
`domainMode=direct` (mapped to production). New `edge` deploys are rejected unless
`ESHOBE_LEGACY_CADDY_EDGE=1`.

Operator flow — one console, one order:

1. Register/sync/publish the package.
2. Assign the package to the site (`POST …/theme-assignment` or admin UI).
3. Deploy preview → review on wildcard URL.
4. Verify customer DNS.
5. Publish production (`lane=production`) — reuses the same production binding/app on updates.

The console is the **«استقرار پوسته»** tab on the site document
(`/admin/collections/sites/:id/deployment`) — platform staff only; a customer's own
staff do not see the tab, the view refuses them, and every route behind it re-checks.
It is laid out as the flow itself — a readiness checklist, a «روی دامنه» / «پیش‌نمایش»
status pair saying which commit runs where, then three numbered steps with one primary
action each:

| Step | Button | Request |
|---|---|---|
| ۱ انتخاب پوسته | «ثبت این پوسته برای سایت» | `POST …/theme-assignment { package }` |
| ۲ پیش‌نمایش | «ساخت پیش‌نمایش» | `POST …/deployment { lane: "preview", package }` — the package's latest commit |
| ۳ انتشار روی دامنه | «انتشار نسخهٔ ‹sha› روی دامنه» | `POST …/deployment { lane: "production", package, artifact }` — the **live preview's artifact**, so what ships is what was reviewed (registry strategy only, see below) |

Step 3 also has «اجرای دوبارهٔ نسخهٔ فعلی» (`POST …/redeploy { lane: "production" }`):
the current production version again, for changed «تنظیمات پوسته» variables, a new
primary domain (`needsRedeploy`) or a broken container. `/redeploy` resolves its source
row within the `lane` it is given, so a preview redeploy can never rebuild production.

Both buttons pin a version. Step 3 sends the live preview's `artifact` *and* its commit
as `ref` (only when the preview is of the package being published), and redeploy reuses the
source row's artifact and commit. With `registry_image` production runs the reviewed digest;
with `coolify_build` it rebuilds the reviewed commit, which is the same source but not the
same bytes ([`theme-artifacts.md`](./theme-artifacts.md#which-strategy-to-use)). Only an
explicit upgrade, or an API caller that omits `ref`, resolves a branch. Stop, revert
and rollback live in the collapsed «توقف و بازگشت» and «تاریخچهٔ استقرارها» sections.
A direct link to the tab sits on
the **«نمای ۳۶۰ مشتری»** overview pane. Rows in **«انتشارها»** (`site-deployments`) are
history: `create` on that collection is closed to everybody, admins included — a row is
born in `createDeployment` with its artifact and hostnames already resolved, and a
hand-made row (no artifact, no preview hostname) is a row that can only fail at run time.

---

## 4 (legacy). The three domain modes (historical rows)

| Mode | Customer DNS | Coolify app answers on | Caddy | `renderedBy` after success |
|---|---|---|---|---|
| `preview` | unchanged | `<domain>-<key>-preview.<wildcard>` only | not involved | unchanged |
| `edge` *(recommended)* | Caddy | `<domain>-<key>.<wildcard>` only | proxies **pages** of the customer domain to the app; `/api/*` stays on `web:3000` | `deployment` |
| `direct` | Coolify | the customer domain **and** `<domain>-<key>.<wildcard>` | not in the path any more | `deployment` |

- Anything but `preview` requires `domainVerified`.
- `direct` is refused unless the manifest declares `proxiesApi: true` — otherwise checkout,
  forms and media stop working the moment DNS moves.
- A preview is a **rehearsal**: it has its own Coolify application and hostname, so
  previewing a new version never rebuilds the container production runs on; a preview
  going live never supersedes an `edge`/`direct` deployment and never touches the site.
- `/api/domain-check` refuses a certificate for a hostname a *live `direct`* deployment has
  taken off the edge; `edge` sites keep getting theirs.

---

## 5. A deployment's lifecycle

```
POST …/deployment ─► queued ─► creating ─► building ─► verifying ─► live
                        │          │           │            │
                        └──────────┴───────────┴────────────┴─► failed ─► (retry = new row / queued)
                                                                live ─► stopped
```

1. **Create** (`POST /api/platform/sites/:id/deployment`, 202). Every refusal that needs no
   network happens here, before a row exists: site not active, package unpublished,
   wrong site type, plan without `requiredFeature`, no target, unsafe ref, unverified
   domain for `edge`/`direct`, `direct` without `proxiesApi`, target without a wildcard
   domain. The ref is `effectiveRefFor`: explicit ref › pinned commit › default ref.
2. **Run** — the jobs queue (`advanceDeployments`, once a minute; `POST …/poll` does the
   same step on demand). Each tick takes at most 10 in-flight rows, oldest `updatedAt`
   first, and works through them **one after another**, on the same `default` queue as
   scheduled publishing. The row is claimed `queued → creating`, the site is re-checked
   (a site suspended while its deploy waited is refused), and then:
   - an incomplete row is repaired first, before anything plans from it: a registry row
     that arrived without its artifact link gets the ready artifact for its commit
     (its own ref when that is a sha, else what the package would deploy now — never
     overriding an artifact an operator chose), and a row missing its preview hostname
     gets one derived exactly as `createDeployment` derives it;
   - the Coolify application is found by its deterministic name or created — **`appUuid` is
     stored before anything else can fail**; a reused application is re-pointed at the new
     branch/commit/image and hostnames before it builds, via `PATCH` with only the fields
     Coolify's update route accepts (no placement or credential fields, which its allowlist
     rejects);
   - a `role: "site"` API key is minted for this deployment;
   - the environment is written (`buildEnvironment` — platform values last, so a tenant
     value can never shadow them; tenant secrets decrypted only here);
   - the build starts → `building`.
3. **Poll** — Coolify's build status moves the row to `verifying` or `failed`.
4. **Verify** — refused if the site is no longer active, or (for `edge`/`direct`) if the
   site's primary domain is not the one this build was made for or is unverified. Then a
   health check against the **application's own hostname** (the preview name — the
   customer domain may still point at Caddy, whose built-in renderer would answer 200),
   at the manifest's `healthCheckPath` (else `/`). The probe does not follow redirects. A
   2xx passes; a 3xx passes only on the `/` fallback, never on a declared health path.
   A 404/502/503/504 or a network error (DNS, refused, timeout) means "not answering yet":
   it is retried within the tick (`DEPLOY_HEALTH_ATTEMPTS`, default 6, `DEPLOY_HEALTH_RETRY_MS`,
   default 5000 apart) but never past `DEPLOY_HEALTH_BUDGET_MS` (default 30 s) per row per
   tick, then retried on later ticks until `DEPLOY_HEALTH_DEADLINE_MS` (default 10 min)
   after the first unanswered probe, which fails the row. Any other status fails it at once.
5. **Promote** — the row becomes `live` first, then what it replaces is stopped (every
   other row of the site for `edge`/`direct`; only other previews for `preview`), then for
   `edge`/`direct` the package's design defaults are copied only if this is the
   first successful adoption of a different theme, then `renderedBy`/`activeDeployment` switch.

A row whose `updatedAt` has not changed for an hour is failed by the queue. A `verifying`
row rewrites `lastError` on every retry, so it is bounded by the health deadline above
instead; while it waits, `healthCheckedAt` holds the time of the first unanswered probe.
**A failed deploy changes
nothing but its own row**: the previous live deployment and the site stay exactly as they
were. One caveat, from sharing an application between redeploys of the same theme: the
new container replaces the old one through Coolify's own deploy of that application. A
build that fails leaves the running container in place; whether an *unhealthy* new
container is swapped in is Coolify's rolling-update behaviour, which depends on the
application having a health check — so declare `healthCheckPath` in the manifest.

---

## 6. Redeploy, upgrade, rollback, stop, revert

- **Redeploy / upgrade** — `POST …/deployment/redeploy` (the console's «اجرای دوبارهٔ نسخهٔ
  فعلی») creates a *new* row from the latest deployment in the requested `lane` (its
  package and target), for the site's *current* primary domain. It runs every check a
  create does. The body is `{ lane?, ref?, domainMode?, artifact?, upgrade? }`:
  - by default it runs the source row's own version: its artifact (registry, no build) and
    its commit (`coolify_build` rebuilds that commit);
  - `upgrade: true` takes what the package would deploy now: the ready artifact for the
    pinned/synced commit (registry), or the effective ref, pin else `defaultRef` HEAD
    (`coolify_build`). An explicit `artifact` or `ref` overrides either.
- **New version available** — `GET …/deployment` reports `update: { deployedCommit,
  latestCommit, packageRef, updateAvailable }` for a live deployment. `latestCommit` is the
  pin, else `syncedCommitSha`; the comparison is between commit shas, never branch names,
  and it is "different from what the package would deploy now" — the CMS does not order
  commits. No GitHub request is made to answer it; **run a sync to learn about a new
  commit** (upgrades are opt-in per site, `is_auto_deploy_enabled` is `false` on every
  application). The console shows «نسخهٔ جدید موجود است».
- **Rollback** — `POST …/rollback { deployment }` redeploys that row's `commitSha` as a new
  row, in that row's lane. A registry row reuses its artifact and digest, with no build. A
  `coolify_build` row is rebuilt: the sha goes to Coolify as `git_commit_sha` on the default
  branch. An explicit commit beats the package's pin.
- **Stop** — `POST …/stop { deployment }` stops the Coolify application (never deletes it),
  marks the row `stopped`, revokes its API key and, if it served the site, hands the site
  back to the built-in renderer. Repeating a stop only repeats the Coolify call — which is
  how an operator retries a stop Coolify did not acknowledge (the row's `lastError` says so).
- **Revert** — `POST …/revert` stops everything the site has running and sets
  `renderedBy: platform`. The escape hatch that makes the feature safe to try.

---

## 7. The site's lifecycle

A hook on `sites` (`src/deploy/lifecycle.ts`) applies the same rules whichever path wrote
the site — the admin form, `PATCH /api/platform/sites/:id`, `PATCH /api/site/domain`, the
subscription lifecycle.

- **Suspended or archived** — every deployment holding (or about to hold) an application
  is stopped through `stopDeployment`: live, preview, in-flight and queued rows, plus failed
  rows whose container may still be up. Applications are kept, history is kept, keys are
  revoked, the site returns to the built-in renderer, whose holding page answers for it.
  Best-effort: a Coolify outage does not block the suspension; it is logged and written
  onto the row so the operator can press stop again.
- **Reactivated** — nothing is restarted and nothing is queued. The site is *eligible* to
  be deployed again; an operator redeploys when they choose to.
- **Primary domain changed** — a live `edge`/`direct` deployment built for the old domain
  is left running but is reported `needsRedeploy` by `GET …/deployment`, with the message
  «دامنهٔ اصلی سایت پس از این استقرار تغییر کرده است. برای فعال‌شدن پوسته روی دامنهٔ جدید،
  استقرار مجدد انجام دهید.» The routing table drops it (the new domain is served by the
  built-in renderer meanwhile), promotion of any build made for the old domain is refused,
  and `domainVerified` is reset by the domain change itself. Verify the new domain, then
  redeploy. `needsRedeploy` is derived from the rows on read, never stored — it cannot drift.

---

## 8. Tenant settings («تنظیمات پوسته»)

The customer-facing half. A document tab on the site, visible to the site's own staff and
to operators, generated from the manifest of the theme the site runs (the live production
deployment, else a live preview, else the most recent attempt — a first deploy that failed
for want of a required value is exactly when the form is needed). No theme → an
explanatory empty state.

Backed by `GET|POST /api/site-theme-settings/current?site=<id>` (collection endpoints):

- an admin **session** only; the caller must be a member of that site (or platform staff).
  Owners write, editors read. A site key, another site's staff and anonymous callers get
  403. The package is resolved server-side; a package or site in the body is ignored.
- deployment environment accepts only keys the manifest declares `source: "tenant"`; a platform variable
  (`ESHOBE_*`) or an undeclared key is a 400 and nothing is written; values are capped at
  2048 characters.
- secrets are write-only: encrypted at rest, masked on every read (an `afterRead` hook the
  deploy job bypasses with a context flag), reported only as "set". A blank secret box
  means *unchanged*; «حذف مقدار ذخیره‌شده» is the explicit clear.
- runtime settings are generated from the manifest's closed schema and take effect immediately without a deployment;
- content selectors are generated from `contentSlots`, and every selected relationship is checked against the same tenant;
- the raw `site-theme-settings` collection's create/update are platform-only.

Environment values take effect on the next deployment. Runtime settings and bindings trigger
signed renderer revalidation on save. A value a newer manifest no longer declares is ignored,
not a deploy failure.

---

## 9. Routing through Caddy (`edge` mode)

`buildRoutingTable` (`src/deploy/routing.ts`) emits a route only for a deployment that is
`live`, in `edge` mode, on an `active` site whose primary domain is verified and still equal
to the deployment's `domain` — plus that site's *verified* aliases. It is served as
`GET /api/platform/routing` and rendered into `theme-routes.caddy`:

```caddy
map {host} {theme_upstream} {
	default ""
	acme.ir acme-ir-bazaar.sites.example.com
}
```

The Caddyfile's `@themed` matcher proxies non-API paths to `https://{theme_upstream}` with
the upstream's own `Host` and `X-Forwarded-Host: {host}`; every `/api/*` carve-out precedes
it, and `/admin*` on a customer domain stays a 404.

**Automatic regeneration.** When `THEME_ROUTES_FILE` is set, the web process rewrites the
file itself:

- requested after every transition that can change it — an edge deployment going live,
  stopping or being superseded (rollback and redeploy included), revert, and a site's
  status, primary domain, verification or verified aliases changing while it is themed;
  not requested for previews, `direct` rows or sites with no deployed theme;
- coalesced for one second, then built from committed state on a fresh connection;
- written atomically (temporary file + rename) and skipped when no route changed;
- best-effort: a failure is logged and the previous map stays; nothing that requested it
  fails. The queue task also regenerates once a minute as a safety net (unchanged maps
  are not rewritten).

In `docker-compose.prod.yml` the map lives in the `theme_routes` volume: written by `web`
at `/app/theme-routes/theme-routes.caddy`, mounted read-only into Caddy at
`/etc/caddy/theme-routes/`, which runs with `--watch` and reloads when the adapted config
changes. A directory volume rather than a bind-mounted file, because a rename is invisible
through a single-file bind mount. The image seeds the volume with the committed empty map;
a missing import is a Caddy that will not boot, which is also why `theme-routes.caddy` is
committed.

**Without `THEME_ROUTES_FILE`** (a topology where the web process cannot write Caddy's
file) run the script from cron or after a deploy:

```sh
CMS_URL=https://admin.example.com PLATFORM_API_KEY=eshobe_live_… \
  node scripts/render-theme-routes.mjs /etc/caddy/theme-routes/theme-routes.caddy
```

It shares the renderer, exits non-zero without touching the file on any failure, and
needs `caddy reload` unless Caddy runs with `--watch`.

The srv1/Komodo deployment does not run the bundled Caddy (customer-domain TLS is out of
scope there), so it has no theme routes; `preview` works everywhere a target exists.

---

## 10. Content changes reach the theme

`notifyRenderers` posts to every live deployment of the site at
`https://<application host>/api/revalidate` (the preview hostname — in `edge` mode the
customer domain's `/api/*` belongs to the CMS), signed with that deployment's own
`ESHOBE_REVALIDATE_SECRET`, plus the global `REVALIDATE_WEBHOOK_URL` fallback.

The v1 signature is `x-eshobe-signature: sha256=<hex HMAC-SHA256(secret, rawBody)>` — the
raw body only. `x-eshobe-timestamp` is sent but **not** signed. This differs from the
platform webhooks (`<timestamp>.<body>`) on purpose: deployed themes verify the published v1
scheme, and changing it would make every one of them reject every notice silently. A
timestamped signature is a v2 contract change, made in `THEME_API.md` first.
`tests/int/renderer-webhook.int.spec.ts` pins the exact bytes.

---

## 11. Secrets

| Secret | At rest | Leaves the process |
|---|---|---|
| Coolify token (`deploy-targets.apiToken`) | AES-256-GCM, `src/lib/deploy/crypto.ts` | never; masked on read, blank = unchanged, `clearApiToken` to wipe |
| Tenant secret answers (`site-theme-settings.secretValues`) | AES-256-GCM | only into the Coolify environment at deploy time |
| Deployment site key | hash only (`api-keys`) | once, into the Coolify environment; revoked on stop/supersede |
| Revalidation secret (`site-deployments.revalidateSecret`) | AES-256-GCM | into the Coolify environment; field unreadable |

`ESHOBE_API_KEY` and `ESHOBE_REVALIDATE_SECRET` are runtime-only variables. Coolify's error
bodies and log tails are scrubbed (`scrubDetail`) before they reach a row. No API response
carries ciphertext. Rotating `DEPLOY_SECRET_KEY` (or `PAYLOAD_SECRET` when it is unset)
invalidates every stored token and tenant secret; there is no re-encryption job.

---

## 11b. Control-plane configuration

Read per call from the **web** process's environment. Every compose file passes `web` an
explicit allowlist, so a variable set in Komodo/Coolify but missing from that list never
reaches the process. `docker-compose.srv1.yml` passes the four secrets below (blank by
default); the tuning variables use their defaults there.

| Variable | Needed for | Unset means |
|---|---|---|
| `ESHOBE_THEME_ARTIFACT_SECRET` | `registry_image` CI callbacks | Callback answers 503; no artifact can be registered, so no registry deploy can run. |
| `GITHUB_THEME_TOKEN` | Sync of a **private** theme repository (read-only PAT) | Sync of a private repo fails; public repos are unaffected. |
| `GITHUB_THEME_WEBHOOK_SECRET` | `POST /api/platform/theme-packages/github-webhook` | Webhook answers 503; manual sync still works. |
| `DEPLOY_SECRET_KEY` | Encrypting Coolify tokens and tenant secrets | Falls back to `PAYLOAD_SECRET`. Setting it later makes every stored value undecryptable (§11). |
| `DEPLOY_CMS_URL` | `ESHOBE_CMS_URL` given to themes when the public origin is not reachable from the container | `NEXT_PUBLIC_SERVER_URL`. Leave unset in production. |
| `DEPLOY_PUBLIC_SCHEME` | `http` for local Coolify only | `https`. |
| `DEPLOY_HEALTH_ATTEMPTS`, `DEPLOY_HEALTH_RETRY_MS`, `DEPLOY_HEALTH_BUDGET_MS`, `DEPLOY_HEALTH_DEADLINE_MS` | Tuning the promotion probe (§5) | 6 attempts, 5000 ms apart, 30 s per tick, 10 min overall. |
| `THEME_ROUTES_FILE` | Legacy `edge` only (§9) | Routes are rendered by the script instead. |
| `JOBS_AUTORUN` | Running the queue that advances deployments | Rows stay «در صف» unless «بررسی وضعیت» is pressed. |

### After a CMS upgrade

Schema changes to the deployment collections, and to anything Payload itself expects (the
Payload 3.90 upgrade added columns in `20261004_130000_payload_390_columns.ts`), ship as
migrations. In production the one-shot `migrate` service applies them before `web` starts,
and a failed migration keeps the new `web` from starting at all. A deploy console that
errors with `column … does not exist` after an upgrade means that step did not run against
this database (`pnpm payload migrate:status`).

---

## 12. Troubleshooting

| Symptom | Look at |
|---|---|
| Stays «در صف» | The jobs queue is not running (`JOBS_AUTORUN`, `src/instrumentation.ts`); «بررسی وضعیت» advances it by hand. |
| Stays «در حال بررسی سلامت» with «پوسته پاسخ نداد» in `lastError` | The application hostname does not resolve or refuses connections from the CMS. It is retried every minute and fails at the health deadline (§5); fix DNS/proxy and redeploy. |
| `failed` with «بررسی سلامت پاسخ 30x گرفت» | The declared `healthCheckPath` redirects. It must answer 200 itself. |
| CI registration answers 503 / 401 / 422 | 503: `ESHOBE_THEME_ARTIFACT_SECRET` is not in the web process (§11b). 401: the secret differs or the body was re-serialised after signing. 422: `repository` or `image` does not match the package row. See `theme-artifacts.md`. |
| CI registration answers 404 from a customer domain | `ESHOBE_CMS_URL` in the theme repo must be the control-plane origin; `/api/platform/*` is not routed on customer domains. |
| Production shows code that was not in the preview | The deploy was made over the API without `ref`, or with `upgrade: true`, on a `coolify_build` package; those build `defaultRef` HEAD (§4). |
| `failed` with «تنظیمات پوسته کامل نیست» | A required tenant variable is empty — the customer fills it in «تنظیمات پوسته», then redeploy. |
| `failed` at verification with the domain message | The primary domain changed during the build. Verify the new domain, redeploy. |
| `failed` with «برای این کامیت هنوز تصویر آماده و تأییدشده‌ای وجود ندارد» | A registry-strategy package whose commit has no ready `theme-artifacts` row. The CI callback (see `docs/theme-artifacts.md`) registers one; wait for the build or deploy the artifact that exists. A row that arrives without an artifact is repaired automatically at run time — this message now means the registry genuinely has nothing ready for that commit. |
| `failed` at re-pointing with Coolify «Validation failed» | The PATCH contract changed: `src/deploy/coolify.ts` `repointApplication` builds the body from Coolify's update-route allowlist; its doc comment records the shapes (digest pin as `repo@sha256` name + bare-hash tag). |
| Domain or preview URL 503 «no available server» | Coolify's container health check could not connect: apps get `health_check_host: 127.0.0.1` pinned for exactly this (IPv6 `localhost` → `::1` refused). If a container is unhealthy, its port binding is the next thing to check. |
| Live, but the customer domain shows the built-in site | `edge`: is the site's domain verified and equal to the row's `domain`? Is `theme-routes.caddy` current (`GET /api/platform/routing`, the web log's `theme routes:` lines)? Is Caddy running with `--watch`? |
| `needsRedeploy` in the console | §7 — the domain moved after the deploy. |
| «نسخهٔ جدید موجود است» never appears | Run a sync: the notice compares against the commit the last sync resolved. |
| A stop left a container running | The row's `lastError` says Coolify refused; press stop again. |
| Everything disappeared after a key rotation | §11 — re-enter the Coolify token and ask customers to re-enter secrets. |

---

## 13. Not built

Stated so nobody reads their absence as a bug:

- a customer-facing theme picker or deploy button (§1);
- deleting Coolify applications — the platform only stops them; the `removed` status
  records one an operator deleted by hand;
- automatic GitHub polling for new commits — a sync is the operator's action;
- ordering commits ("newer" vs "different") — `updateAvailable` means "different from what
  the package would deploy now";
- a timestamp-signed revalidation webhook (a v2 contract).

## Tenant runtime configuration boundary

Code, repositories, targets, deployment environment, promotion and logs remain operator
concerns. Site owners manage reusable branding, generic design tokens, manifest-declared
runtime options and content mappings. These values are delivered through `/api/site` and
updated without a Coolify rebuild; editor-facing presentation toggles must not use `env`.
