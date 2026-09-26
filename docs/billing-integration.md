# Billing integration

cafe-restaurant-pos is the commercial authority. eshobe-cms is the website
execution plane.

CMS does not decide what a customer owes and does not price a resource. It
reports that a site consumed a quantity of a known meter, and it enforces the
entitlement projection central Billing last delivered.

## Ownership

| Concern | Owner |
|---|---|
| Plans, prices, subscriptions, invoices, wallet, credits, overage | cafe-restaurant-pos |
| Website content, rendering, domains, storage, deployments | eshobe-cms |
| Entitlement projection (cache) | eshobe-cms, written only by central Billing |
| Local quota counts and enforcement | eshobe-cms |
| Raw usage and the durable outbox | eshobe-cms |

`plans`, `subscriptions` and `invoices` remain as a read-only archive. Their
create, update and delete access is closed, a `beforeValidate` hook refuses
writes, and the old operator routes answer **410**. They are hidden from the
admin nav. Nothing in the application sets `allowLegacyCommercialWrite`.

## Quota metrics are not billing meters

Quota metrics (`pages`, `posts`, `products`, `media`, `mediaStorageMb`,
`categories`, `users`, `apiKeys`, `ordersPerMonth`, `apiRequestsPerMonth`,
`domains`) are product limits. `usage-records` is an approximate operational
counter for `apiRequestsPerMonth` only. It uses read-modify-write and may lose
increments. It must not feed an invoice.

Billing meters are a closed registry in `src/billing/meters/registry.ts`:

| Key | Unit | How it is collected |
|---|---|---|
| `cms.api_request` | request | Site API key on a customer API path, folded per UTC hour |
| `cms.origin_transfer_bytes` | byte | Bytes actually returned by the object-storage proxy |
| `cms.bandwidth_bytes` | byte | Ingest only. CMS has no CDN byte counter and does not invent one |
| `cms.storage_byte_hour` | byte_hour | Time-weighted integral of stored object bytes |
| `cms.deployment` | deployment | One event after a production `edge` or `direct` promotion reaches `live` |
| `cms.build_second` | second | Ingest only. CMS does not invent build duration |

Unknown meter keys are rejected. Domain registration and renewal are not
emitted: CMS has no single durable success transition that is safe to bill.

## Usage contract

Namespace `billing-contract/v1`. Source `eshobe-cms`.

`POST {CENTRAL_BILLING_URL}/api/internal/billing/usage/v1/batch`

```json
{
  "source": "eshobe-cms",
  "contractVersion": 1,
  "events": [
    {
      "eventId": "cms:<site>:api_request:<hour>",
      "siteId": "<site uuid>",
      "meterKey": "cms.api_request",
      "quantity": 18423,
      "unit": "request",
      "periodStart": "2026-09-26T13:00:00.000Z",
      "periodEnd": "2026-09-26T14:00:00.000Z",
      "occurredAt": "2026-09-26T13:00:00.000Z",
      "resourceType": null,
      "resourceId": null,
      "dimensions": { "source": "site-api-key" }
    }
  ]
}
```

The body must not contain `businessId`, a price, a wallet amount, a currency
or an invoice total. Central Billing maps `siteId` to a business through its
own connection table.

Event ids are deterministic. The same hour, deployment or correction delta
names the same event, so a retry is a duplicate rather than a second charge.

A wrong accepted measurement is not edited. A correction event carries
`correctsEventId`, `correctionReason` and `actor`.

## Outbox

`billing-usage-outbox` survives process restarts. Statuses: `pending`,
`sending`, `sent`, `failed`, `dead_letter`. A row is `sent` only after central
Billing names it `accepted` or `duplicate`.

The jobs task `billingIntegration` leases at most 50 rows, marks them
`sending` with a lease token, posts one batch, and applies each result.
Transient failures use exponential backoff with jitter, capped at one hour.
After 8 attempts, or on a permanent reason (`unknown_meter`, `invalid_unit`,
`invalid_event`, `contract_mismatch`, `permanent`), the row becomes
`dead_letter`. A lease older than 10 minutes returns to `pending`, so a
crashed worker does not strand the batch.

`POST /api/platform/billing/outbox/:eventId/replay` (admin session) puts a
failed or dead-letter row back to `pending`. The event id does not change.

High-volume counters land in an in-memory buffer, then in
`billing-usage-samples` (append-only), then fold into one hourly outbox row.
Every replica may flush samples. Only the jobs replica publishes.
`JOBS_AUTORUN` remains the switch for that publisher.

## Entitlement projection

`central-entitlement-projections` holds one row per site. Central Billing
pushes `POST /api/platform/billing/entitlements/v1`. A higher version replaces
the row, the same version is idempotent, a lower version is **409**.

Limits use an explicit clause: `{ "state": "limit", "value": 100 }` or
`{ "state": "unlimited" }`. An absent key is unspecified. Zero is not a
limit and not unlimited.

`resolveEntitlement` reads the projection when `BILLING_CUTOVER=central`
(the default) and a row exists. It does not call central Billing. A missing
projection falls back to the read-only legacy merge so a sync gap does not
blank a site. `dual` serves the legacy answer and logs mismatches. `legacy`
never reads the projection.

`serving` on the projection is the commercial serving flag. `past_due` does
not suspend the CMS site. `sites.status` (`suspended`, `archived`) remains
the technical lifecycle and still stops deployments.

Commercial features come from the projection. `feature-flags.technicallyAvailable`
and `site-entitlements.technicalHolds` can turn a granted feature off. They
cannot turn one on. `site-entitlements.features` and `limitOverrides` are
stripped on write.

Local quota enforcement still counts local rows and does not call central
Billing on each create.

## Service auth

`billing-service-credentials` is not a platform key. Scopes are only
`billing.usage.write` and `billing.entitlement.write`. The secret is AES-GCM
(`eshobe-cms:billing-service:v1`), blanked on read, and returned once from
`POST /api/platform/billing/credentials` (admin session).

**Who mints what:** CMS issues `billing.entitlement.write` through
`POST /api/platform/billing/credentials` (admin session). Store the returned
`keyId` and `secret` in the platform operator configuration. Central Billing
issues `billing.usage.write`; an operator creates that credential on the platform,
then saves the `keyId` and `secret` into CMS (`billing-service-credentials`, encrypted
at rest). The outbox publisher is the only consumer. The credential issue route
refuses to mint `billing.usage.write` on CMS.

Requests are signed `HMAC-SHA256` over `<unix-seconds>.<body>` using the same
helper as platform webhooks. Headers: `x-eshobe-billing-key`,
`x-eshobe-billing-timestamp`, `x-eshobe-billing-signature`. The replay window
is five minutes. A repeated body fingerprint is refused. The secret is never
logged. Until central Billing verifies v1 signatures on usage ingest, CMS may
set `BILLING_USAGE_AUTH=legacy-nonce` to speak the deprecated nonce/body-hash
protocol outbound only (`src/billing/auth/compat/`).

`CENTRAL_BILLING_URL` must be HTTPS in production, must not carry userinfo,
and must not target link-local or metadata hosts. Calls time out at 10
seconds and refuse an acknowledgement larger than 1_000_000 characters.

These routes stay on `/api/platform/*` and `/api` is not carved onto customer
domains.

## Cutover

`BILLING_CUTOVER`:

| Phase | Reads | Writes |
|---|---|---|
| `legacy` | Archived plan/subscription merge | Frozen |
| `dual` | Legacy answer, mismatches logged | Frozen |
| `central` (default) | Projection when present, else legacy read | Frozen |

`GET /api/platform/billing/migration` inventories plans, subscriptions,
invoices and overrides. Seeding projections refuses to run when a site has
more than one entitled subscription. `POST /api/platform/billing/migration/seed`
writes version 1 from that archive and does not overwrite a newer projection.

## Operator surface

The «اشتراک و مالی» group is gone. Operators see read-only commercial status
(projection, outbox) and a dashboard of outbox backlog, dead letters, last
publish and sites still missing a projection. Customer 360 shows plan code,
version, serving and unsent usage. It does not edit a plan or an invoice.

`GET /api/platform/self/entitlement` still answers a site key from the local
projection and quota state. It does not include prices, wallets or another
tenant.

`platform-settings` still stores `invoiceDueDays`, `taxPercent`,
`autoRenewInvoices` and `invoiceFooter`. Those fields are read-only. The
settings patch rejects them. No job reads them to draft an invoice.

Central Billing does not yet expose an entitlement pull. CMS accepts the
signed push and keeps serving the last projection when the push is late.
A periodic pull waits on that API. Missing `CENTRAL_BILLING_URL` leaves
outbox rows pending; it does not mark them sent.
