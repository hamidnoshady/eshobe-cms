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
