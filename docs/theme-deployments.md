# Deployable themes — from a GitHub repo to a running site on Coolify

**Status: implemented (Wave 11).** This document describes the system as it runs. The
author's side of the contract — `eshobe.theme.json`, the environment a theme receives,
the revalidation webhook — is [`docs/THEME_API.md`](./THEME_API.md) §17 and §17b. The
HTTP surface is [`docs/platform-control-api.md`](./platform-control-api.md) §9.

A theme built against the Theme API lives in its own GitHub repository. The operator
registers it, the platform builds and runs it on the operator's own Coolify, attaches the
customer's domain, and keeps it in step with the site's lifecycle.

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
| Token presets | `theme-templates` | platform | Paint only. A package may name one to copy onto a site when it goes live. |
| **Deployable theme** | `theme-packages` | platform | A repository + the manifest its last sync read + the commit that sync resolved. |
| **Coolify connection** | `deploy-targets` | platform | Base URL, encrypted API token, server/project, wildcard preview domain. |
| **One attempt** | `site-deployments` | site | site × package × target: status, mode, hostnames, ref/commit, Coolify ids, log tail. History is kept. |
| **Tenant answers** | `site-theme-settings` | site | The customer's values for the manifest's `source: "tenant"` variables (one document per site). |

`theme-packages` and `deploy-targets` are platform-wide (the documented exception to the
multi-tenant registration rule, and in `platformWide` in `tests/int/store.int.spec.ts`).
`site-deployments` and `site-theme-settings` are registered with the multi-tenant plugin.

`sites.renderedBy` (`platform` | `deployment`) and `sites.activeDeployment` say who serves
the customer's domain. Both are written only by the deploy service (field access denies
every caller, including platform admins, so a stale admin form cannot put an old value
back).

---

## 3. Registering a theme

1. Create a `theme-packages` row: repository (`owner/name`), visibility, default ref, and
   optionally a **pinned commit** (every new deploy then builds exactly that commit),
   a default target, a `requiredFeature` (a plan feature key) and a token template.
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

## 4. The three domain modes

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
   same step on demand). The row is claimed `queued → creating`, the site is re-checked
   (a site suspended while its deploy waited is refused), and then:
   - the Coolify application is found by its deterministic name or created — **`appUuid` is
     stored before anything else can fail**; a reused application is re-pointed at the new
     branch/commit and hostnames before it builds;
   - a `role: "site"` API key is minted for this deployment;
   - the environment is written (`buildEnvironment` — platform values last, so a tenant
     value can never shadow them; tenant secrets decrypted only here);
   - the build starts → `building`.
3. **Poll** — Coolify's build status moves the row to `verifying` or `failed`.
4. **Verify** — refused if the site is no longer active, or (for `edge`/`direct`) if the
   site's primary domain is not the one this build was made for or is unverified. Then a
   health check against the **application's own hostname** (the preview name — the
   customer domain may still point at Caddy, whose built-in renderer would answer 200).
5. **Promote** — the row becomes `live` first, then what it replaces is stopped (every
   other row of the site for `edge`/`direct`; only other previews for `preview`), then for
   `edge`/`direct` the package's token template is copied onto the site and
   `renderedBy`/`activeDeployment` switch.

A row that has not moved for an hour is failed by the queue. **A failed deploy changes
nothing but its own row**: the previous live deployment and the site stay exactly as they
were. One caveat, from sharing an application between redeploys of the same theme: the
new container replaces the old one through Coolify's own deploy of that application. A
build that fails leaves the running container in place; whether an *unhealthy* new
container is swapped in is Coolify's rolling-update behaviour, which depends on the
application having a health check — so declare `healthCheckPath` in the manifest.

---

## 6. Redeploy, upgrade, rollback, stop, revert

- **Redeploy / upgrade** — `POST …/deployment/redeploy` (the console's «استقرار مجدد»)
  creates a *new* row from the deployment the site runs (its package, target and mode), at
  the ref the package would deploy now, for the site's *current* primary domain. `{ ref?,
  domainMode? }` may override those two and nothing else. It runs every check a create does.
- **New version available** — `GET …/deployment` reports `update: { deployedCommit,
  latestCommit, packageRef, updateAvailable }` for a live deployment. `latestCommit` is the
  pin, else `syncedCommitSha`; the comparison is between commit shas, never branch names,
  and it is "different from what the package would deploy now" — the CMS does not order
  commits. No GitHub request is made to answer it; **run a sync to learn about a new
  commit** (upgrades are opt-in per site, `is_auto_deploy_enabled` is `false` on every
  application). The console shows «نسخهٔ جدید موجود است».
- **Rollback** — `POST …/rollback { deployment }` redeploys that row's `commitSha` as a new
  row. An explicit commit beats the package's pin; a sha is built as `git_commit_sha` on
  the default branch.
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
- only keys the manifest declares `source: "tenant"` are accepted; a platform variable
  (`ESHOBE_*`) or an undeclared key is a 400 and nothing is written; values are capped at
  2048 characters.
- secrets are write-only: encrypted at rest, masked on every read (an `afterRead` hook the
  deploy job bypasses with a context flag), reported only as "set". A blank secret box
  means *unchanged*; «حذف مقدار ذخیره‌شده» is the explicit clear.
- the raw `site-theme-settings` collection's create/update are platform-only.

Values take effect on the next deployment. A value a newer manifest no longer declares is
ignored, not a deploy failure.

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

## 12. Troubleshooting

| Symptom | Look at |
|---|---|
| Stays «در صف» | The jobs queue is not running (`JOBS_AUTORUN`, `src/instrumentation.ts`); «بررسی وضعیت» advances it by hand. |
| `failed` with «تنظیمات پوسته کامل نیست» | A required tenant variable is empty — the customer fills it in «تنظیمات پوسته», then redeploy. |
| `failed` at verification with the domain message | The primary domain changed during the build. Verify the new domain, redeploy. |
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
