# `/api/platform/*` — administering the whole deployment from outside it

> The CMS admin edits **one site**. This surface answers the **operator's**
> questions, which are all cross-site — and it is what the sibling
> [`cafe-restaurant-pos`](https://github.com/hamidnoshady/cafe-restaurant-pos)
> super-admin console («سایت‌ساز») is built from. One CMS address plus one
> `role: "platform"` key, and that console administers and reports on this
> deployment without an operator ever opening `/admin`.

Code: `src/endpoints/platformControl.ts` (HTTP), `src/platform/{report,events,snapshot}.ts`
(services), `src/lib/platform-control.ts` (the pure half — clamping, report arithmetic,
snapshot rules), `tests/int/platform-control.int.spec.ts`.

## 1. Who may call it

A **platform-admin session** or a **`role: "platform"` API key** — the same boundary
`POST /api/provision-site` and `POST /api/api-keys/issue` already draw
(`isPlatformAdminOrPlatformKey`). A `role: "site"` key reaches none of it, and the int
spec asserts that on every route including the snapshot pair.

This widens what a platform key can *reach*: it can now read every site's content
through the snapshot export, where before it could only provision sites and issue
keys. That is not a new authority. A platform key could already issue itself a
`role: "site"` key for any site on the deployment (`/api/api-keys/issue` takes a
`siteId`) and read that site's content, drafts included. The least-privilege split
between the two roles was always a shape, never a boundary — the boundary is that a
*site* key still reaches exactly one site, which nothing here changes. Treat a
platform key as what it is: the deployment's root credential.

## 2. Why there is no Caddy carve-out

`/api*` on a customer domain is a 404 by design (`@control_plane_paths`), and these
routes are called with the **control plane's own `Host`** — the POS client only
forwards a site's domain on site-scoped calls, so a platform call routes to the
control-plane block on its own. Leaving it there is the point, and it is the same
decision `POST /api/payments/self-test` records.

## 3. The routes

| Route | What it answers |
|---|---|
| `GET /api/platform/overview?days=30` | The fleet report: sites by status/type, verified vs not, lifetime content counts (published vs total), order counts by status, **paid money per currency for the window**, the gateway table, object storage, the jobs queue, key and user counts. |
| `GET /api/platform/sites?limit=&page=&q=&status=` | Every site with its own counts (pages/posts/products/categories/media/orders), its store currency, its aliases and its gateway rows. Paged — each row is several `count` calls. |
| `GET /api/platform/sites/:id` | One site, same row shape as the list. |
| `PATCH /api/platform/sites/:id` | The site lifecycle: `name`, `type`, `status`, `availableLocales`, `defaultLocale`, `domainVerified`, `domains[]`. |
| `GET /api/platform/events?since=&limit=` | The deployment's own tail: site changes, unverified domains, orders, gateway self-tests, keys issued. Newest first, one stable `id` per record, and a `cursor` to poll from. |
| `GET /api/platform/sites/:id/snapshot?collections=` | That site's content, out. |
| `POST /api/platform/sites/:id/snapshot` | Content, in. `{ snapshot, collections?, dryRun?, force? }`. |

Three staff endpoints that already existed now accept a platform key too, so the
console can run them: `GET /api/payments/status`, `POST /api/payments/self-test`,
`POST /api/storage-connections/self-test`, and the platform-wide CDN trio
(`/api/cdn/status`, `/api/cdn/sync`, `/api/cdn/purge`). **`POST /api/payments/cancel`
deliberately does not** — a refund moves a buyer's money and stays an admin-session
action.

## 4. Rules that are easy to break

- **`domain` is not in the site patch.** Its one write path is
  `PATCH /api/site/domain`, which resets `domainVerified` and re-checks uniqueness
  across every site's primary *and* alias hostnames. A second door onto that column
  would be a second place for the invariant to be forgotten.
- **A report never scans an unbounded table.** Counts come from `payload.count`;
  money has to be summed row by row (Payload has no aggregate, and this codebase
  keeps raw SQL to migrations), so every sum is windowed by `days` **and** capped by
  `ORDER_SCAN_CAP`. A capped scan answers `revenueTruncated: true` rather than
  quietly under-reporting revenue.
- **Sums stay per currency, in minor units.** An order snapshots the currency it sold
  in, so a deployment holds several at once and adding them together would invent a
  number.
- **A snapshot carries content, never identity.** `stripSnapshotFields` removes `id`,
  `site`, `createdAt`, `updatedAt`; the import sets `site` from the URL's site, the
  same rule `forceApiKeySite` applies to a site key's own writes. `_status` **is**
  kept: an operator restoring a snapshot must get the published/draft state back, and
  an import that silently unpublished a live site would be the worse outcome.
- **Nested row ids survive.** Only the document's own top level is stripped, so every
  block's `id` inside `layout` comes back as it left — which is the whole difference
  between a second-locale write being a *translation* and being a *rewrite*
  (CLAUDE.md, Payload section). The site's default locale is always written first for
  the same reason.
- **An import refuses another site's snapshot** unless `force: true`. Relationship
  values (a post's categories, a hero image) are document ids from the source site;
  on another site they name rows it does not own, which is the tenant-leak shape.
  With `force`, each row is attempted and the failures are listed rather than the
  whole import dying on the first bad reference.
- **`media` is not in `SNAPSHOT_COLLECTIONS`.** The files live in object storage
  (WAVE-6) and a JSON snapshot cannot carry them; one that listed them without their
  bytes would read as a backup that is not one.
- **The event cursor is the newest record in the page, never `now`.** A record written
  while the query ran must still be reachable on the next poll — which is also why
  the shipper on the POS side dedupes on `id` and not on the window.

---

# The SaaS control plane

> Everything above administers the **fleet** — which sites exist, what is in them.
> Everything below administers the **business**: who is on which plan, what they owe,
> what they are allowed to use, and what happened. Same guard, same host, same
> `/api/platform/*` prefix, deliberately — a console that already holds a platform
> key gets the commercial surface for free.

Code: `src/endpoints/platformSaas.ts` and `src/endpoints/webhooks.ts` (HTTP),
`src/platform/{entitlements,saas-report,webhooks,audit,usage}.ts` (services),
`src/lib/saas/{plans,events,crypto}.ts` (the pure half),
`tests/int/platform-saas.int.spec.ts`, `tests/int/webhooks.int.spec.ts`,
`tests/e2e/superadmin.e2e.spec.ts`.

## 5. The admin panel is split by role

A platform admin opening `/admin` does **not** see pages, posts, media, products or
orders; a customer's staff do not see plans, invoices, webhooks or the audit log.
`src/admin/visibility.ts` is the whole mechanism (`hiddenFromOperators` /
`hiddenFromCustomers`), and `beforeDashboard` replaces Payload's collection-count
grid with the operator's report for platform admins only.

This is **navigation, not authority.** `admin.hidden` governs the nav and the admin
routes; REST, GraphQL and the Local API are untouched. Every real boundary is a
collection `access` function, which is why a platform admin can still read a
customer's content through `GET /api/platform/sites/:id/snapshot`. Nothing in
`visibility.ts` grants or removes a permission.

`PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS=true` puts the content collections back for an
operator — for hands-on support, and for `tests/e2e/admin.e2e.spec.ts`, whose fixture
user is a platform admin and whose subject is the *editing* experience
(`playwright.config.ts` sets it for that reason).

## 6. The routes

Same guard as §1 (`isPlatformAdminOrPlatformKey`), `cache-control: no-store`, Persian
403s — with the two documented exceptions in §7.

| Route | What it answers |
|---|---|
| `GET /api/platform/saas/overview?days=30` | The commercial report: subscriptions by status and by plan, billed/collected/outstanding **per currency**, overdue invoices, plugin and theme counts, webhook health, audit volume, and the live quota/maintenance/signup policy. |
| `GET /api/platform/plans` | The catalogue: code, name, price, interval, limits, features, active. |
| `GET /api/platform/subscriptions?status=&site=&limit=&page=` | Who is on what, with the period end and any limit overrides. |
| `POST /api/platform/subscriptions` | **Upsert** one site's subscription. `{ siteId, plan, status?, currentPeriodEnd?, limitOverrides? }`; `plan` is a uuid **or** a plan `code`. 201 on create, 200 on change. |
| `PATCH /api/platform/subscriptions/:id` | Status, period, overrides. |
| `GET /api/platform/invoices?status=&site=&limit=&page=` | Invoices with their lines and totals. |
| `POST /api/platform/invoices` | `{ siteId, lines[{description,quantity,unitAmount}], currency?, taxPercent?, discount?, dueAt?, subscriptionId? }`. Totals are derived, never accepted. |
| `POST /api/platform/invoices/:id/pay` | `{ reference?, paidAt? }`. Marks paid, clears a `pastDue` subscription, **409 if already paid**. |
| `GET /api/platform/sites/:id/entitlement` | The resolved answer for one site: plan, limits, features, `serving`, enforcement policy. |
| `GET /api/platform/sites/:id/quota` | Usage against limits, per metric, with `over`/`warning` lists. |
| `POST /api/platform/sites/:id/usage` | Report metered usage from outside (`{ metric, amount, period? }`). |
| `POST /api/platform/sites/:id/features` | Force a flag on or off for one site (`{ key, enabled, reason? }`). |
| `POST /api/platform/sites/:id/theme` | Apply a catalogue template (`{ theme }` — key or uuid). A copy, not a link. |
| `GET /api/platform/plugins?site=` | Installed plugins. **Never their credentials.** |
| `PATCH /api/platform/plugins/:id` | Enable, disable, reconfigure. |
| `GET /api/platform/themes` | The template catalogue with its tokens. |
| `GET /api/platform/features` | The feature-flag catalogue and its defaults. |
| `GET /api/platform/audit?action=&site=&limit=&page=` | Who did what, when, from where. |
| `GET /api/platform/settings` | Platform policy, plus `supportedEvents`. |
| `PATCH /api/platform/settings` | Change it. **Admin session only** — see §7. |
| `GET /api/platform/self/entitlement` | **Site key only.** A customer's own app asking "what am I allowed to do?" |
| `POST /api/webhooks/test` | Send a real signed ping to a real URL. |
| `POST /api/webhooks/rotate-secret` | Mint a signing secret, returned **once**. Admin session only. |
| `POST /api/webhooks/replay` | `{ deliveryId }` — resend the stored bytes. |

## 7. Two deliberate exceptions to §1

- **`PATCH /api/platform/settings` refuses a platform key.** It can switch off quota
  enforcement, open signups and turn on maintenance mode for the whole deployment at
  once. That is root policy, and it should cost the credential a human logs in with —
  the same reasoning that keeps `POST /api/payments/cancel` a session action.
  `POST /api/webhooks/rotate-secret` is session-only for the same reason: a key that
  can mint signing secrets can silently take over a customer's event stream.
- **`GET /api/platform/self/entitlement` refuses everything but a site key.** It is
  the one route on this surface a *customer's* app is meant to call, and it answers
  only about the key's own site. A platform key gets 403 — its view is
  `GET /api/platform/sites/:id/entitlement`, which names the site explicitly.

## 8. Rules that are easy to break

- **Endpoint order is load-bearing.** `platformSaasEndpoints` is spread **before**
  `platformControlEndpoints` in `payload.config.ts`, because the latter declares a
  bare `/platform/sites/:id`. Reversed, `:id` matches the literal segment `quota` and
  `/platform/sites/<id>/quota` answers **200 with a site document** — every caller
  parses it and silently sees no limits. `tests/e2e/superadmin.e2e.spec.ts` pins it
  over HTTP, because a handler-level test cannot see it.
- **The webhook routes are collection endpoints.** Payload dispatches
  `/api/<first-segment>/…` against the matching collection and never falls back to
  `config.endpoints`, so a top-level `/webhooks/test` would 404 forever while the int
  suite stayed green. They live on `Webhooks.endpoints`. Same trap as
  `/api/api-keys/issue`.
- **Blank and zero mean unlimited.** A plan row saved with an empty `posts` box must
  mean "we did not limit posts", never "zero posts allowed" — a new plan's boxes are
  empty by default. `normalizeLimit` is the single implementation.
- **Quota enforcement is off unless asked for.** The platform default is `warn`: the
  overage is reported, nobody is blocked. `enforce` is opt-in, per site
  (`site-entitlements.quotaEnforcement`) or platform-wide. A quota system that
  defaults to blocking turns a half-configured plan into an outage with no
  explanation. A platform admin is **never** blocked — support work happens over a
  customer's limit by definition.
- **`pastDue` keeps a site serving.** A missed payment is a conversation; suspension
  is a separate, deliberate operator action. Paying the invoice clears the flag
  automatically, because leaving that to a human is how a paying customer keeps
  getting dunning emails.
- **One live subscription per site.** `POST /platform/subscriptions` upserts.
  "Which plan is this customer on?" must have exactly one answer, and two rows is how
  somebody gets billed twice.
- **Invoice totals are derived server-side.** `subtotal`, `tax`, `total` and each
  line's `amount` have `access.update: false`, so a posted total never existed. An
  invoice whose printed figure disagrees with its lines cannot be constructed through
  any API here. Paying twice is a **409**, not an overwrite: the second call would
  replace the reference of the payment that really happened.
- **Money stays per currency, in minor units** — same rule as the fleet report, same
  `accumulateOrderTotals`.
- **Entitlement resolves in one place, in one order:** plan → subscription
  `limitOverrides` → `site-entitlements` `limitOverrides`, and only non-null values
  override. Plan *features* grant nothing unless the subscription is `serving`,
  otherwise a cancelled customer keeps every paid feature until somebody notices.
- **A theme template is copied, never linked.** Editing the catalogue must not
  repaint twenty live customers, and after a copy nobody could tell which sites had
  been customised since. `applyThemeTemplate` writes an explicit token allowlist, so
  a token added to `theme` in a later release is left alone on templates stored
  today rather than blanked.
- **Secrets leave the process exactly once.** A webhook signing secret is readable
  only in the `rotate-secret` response; a plugin credential is never returned at all.
  Both list endpoints are built field by field rather than passing a document
  through, because a `select`-less passthrough is how a future field starts leaking
  the day somebody adds it. `enc:v1:` ciphertext must not cross the wire either —
  encrypted or not, it is an offline target.
- **Nothing waits for a receiver.** `emitPlatformEvent` awaits the audit row (a local
  insert, and the trail is the point) and dispatches webhooks in the background. A
  paid order or a provisioned site must not fail because somebody's Slack relay is
  down. The cost is at-most-once delivery, which is why every attempt is recorded and
  why replay exists.
- **A replay resends the stored bytes.** Same event id, same timestamp inside the
  body. A reconstruction would be a new event that never happened, and the receiver
  would have no way to recognise the delivery it missed or to deduplicate it.
- **`POST /api/webhooks/test` is a real delivery** — real signature, real URL — so it
  is logged and counted through the same `recordDelivery` path as any other. A test
  that wrote no row left the operator's replay screen empty for the request they had
  just watched fail.
- **The signature covers `<timestamp>.<body>`**, not the body alone, so a captured
  delivery cannot be replayed forever against a receiver that enforces a window.
- **A webhook scoped to a site hears only that site's events**, and never
  platform-level ones. `site` on a webhook row is a filter, not a label — the tenant
  leak on this surface is site B's operator receiving an event about site A.
- **`consecutiveFailures >= webhookMaxFailures` disables the endpoint.** A dead
  receiver is a support conversation, not an infinite queue. A success clears the
  counter, so a fixed endpoint is not left one failure from being switched off again.
- **The audit log is append-only and redacted.** `create`/`update` are `() => false`
  and rows are written only through `recordAudit` with `overrideAccess`.
  `sanitizeChanges` drops any key matching
  `/secret|password|token|credential|apikey|api_key|keyhash|privatekey|authorization/i`,
  truncates strings to 200 chars and keeps at most 40 fields.
- **Catalogue collections are not tenant-scoped.** `plans`, `feature-flags`,
  `plugins`, `theme-templates`, `webhooks` and `webhook-deliveries` are deliberately
  absent from the multi-tenant plugin's map: the plugin's injected `site` field is
  *required* by construction, so a platform-level row would be unsavable, and "which
  customer owns the Pro plan?" has no answer. The per-customer half —
  `subscriptions`, `invoices`, `site-entitlements`, `usage-records` — **is**
  registered, and `tests/int/store.int.spec.ts` asserts the split so a new collection
  cannot quietly join the wrong side.
