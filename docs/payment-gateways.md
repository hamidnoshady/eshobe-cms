# Eshobe CMS — Iranian Payment Gateways

**For platform operators configuring a tenant, and for headless developers drawing a
checkout.**

*Wave 10. Providers: ZarinPal, Digipay, Snapp!Pay, Torob Pay. Money is always integer minor
units of the **site's** currency (`src/lib/money.ts`). Tenant comes from the `Host` header —
never from a body field or query param. Design decisions and rejected alternatives:
`WAVE-10.md`.*

---

## 1. The thirty-second version

A shop takes online payment when **three** things agree:

1. The platform has the module on (`تنظیمات پرداخت` → *ماژول درگاه‌های پرداخت روشن است*).
2. The platform allows that specific PSP (`تنظیمات پرداخت` → *درگاه‌های مجاز*).
3. The tenant has a `payment-gateways` row for it that is **enabled**, has **complete
   credentials**, and whose **amount window** contains the order.

Miss any one and the gateway is not offered — not offered-and-then-broken. A storefront that
renders no picker is a storefront where step 1, 2 or 3 is false.

---

## 2. Operator guide

### 2.1 Turn the module on (platform admin)

`/admin` → **فروشگاه** → **تنظیمات پرداخت**.

| Field | Effect when off / removed |
| --- | --- |
| *ماژول درگاه‌های پرداخت روشن است* | `GET /api/payments/methods` returns an empty list, no storefront draws a picker, and no tenant can switch a row on. Orders already `pending` with a gateway **still verify** — turning the module off stops new attempts, it does not abandon money in flight. |
| *درگاه‌های مجاز* | A PSP not in this list stops resolving for **every** tenant at once, without editing any customer's configuration. Use it for a provider you have not contracted with, have dropped, or are having an outage with. |

Defaults are on and all-four-allowed, because the dangerous defaults are elsewhere: a new row
is created `enabled: false`, only a platform admin can write a credential, and a row with none
is refused.

### 2.2 Enter a tenant's credentials (platform admin)

`/admin` → **فروشگاه** → **درگاه‌های پرداخت** → create.

Pick the site, pick the gateway, fill the credentials. The form shows only the fields that
gateway uses.

| Gateway | Required | Optional |
| --- | --- | --- |
| **ZarinPal** | `merchantId` (36-char UUID from the ZarinPal panel) | `referrerId`, `baseUrl`, `amountUnit` |
| **Digipay** | `username`, `password`, `clientId`, `clientSecret` | `baseUrl`, `preferredGateway`, `ticketType`, basket fields, `sellerId`, `supplierId` |
| **Snapp!Pay** | `username`, `password`, `clientId`, `clientSecret` | `baseUrl`, `payPageUrl`, `minAmountRial`, `commissionType` |
| **Torob Pay** | `baseUrl` (**no published default** — Torob support issues it with your credentials), plus `token` *or* `username`+`password` | `createPath`, `verifyPath`, `cancelPath`, `amountUnit` |

Then save, and press the row's self-test (or `POST /api/payments/self-test`, §4.3). The result
lands in *آخرین خودآزمایی* on the row.

### 2.3 What you will and will not see afterwards

**The fields render empty after a save. That is correct and it is the point.** No API returns a
credential — not to a tenant, not to you, not through GraphQL, not in an admin list view. What
you get instead is:

- **وضعیت اعتبارنامه‌ها** — how many fields are set, plus a 12-hex-char fingerprint of each
  (`merchantId:9f2c41ab0e7d`). The fingerprint changes when the secret changes, which is the
  only way to answer "did that save?" without being able to read the value back.
- **آخرین تغییر اعتبارنامه‌ها** — when.

**Empty means "unchanged", never "delete".** Because the fields render empty, every save
submits them empty; treating that as a deletion would wipe a merchant's `client_secret` the
moment somebody edited the row's priority. To actually wipe a row, tick
*پاک کردن همهٔ اعتبارنامه‌ها* and save.

### 2.4 What a tenant may do

A site's own staff (and that site's API key) may read the row and change **enabled**,
**priority**, **displayName**, **minAmount**, **maxAmount**. They cannot create or delete a
row, cannot touch a credential, and cannot change which gateway the row is for — a row's
gateway decides which adapter runs and which columns its ciphertext lives in, so changing it
would attribute ZarinPal's encrypted `merchantId` to Digipay's `username`. Create a second row
instead.

Switching `enabled` on is refused, with a Persian sentence naming the problem, when: the module
is off; the gateway is not allowlisted; credentials are incomplete; the site's currency is not
one the PSP settles in; or `minAmount > maxAmount`.

### 2.5 Rotating a key

Credentials are sealed with `PAYMENT_GATEWAYS_KEY`, or with `PAYLOAD_SECRET` when that is
unset. **Rotating either invalidates every stored credential.** There is no re-encryption job.
A platform admin re-enters them; meanwhile a row whose secrets no longer decrypt is refused
with a Persian message at the storefront rather than failing at the PSP — so the symptom is
"the gateway disappeared", not "checkouts are erroring".

Set `PAYMENT_GATEWAYS_KEY` explicitly for exactly this reason: rotating it re-encrypts
credentials without logging every editor out, whereas rotating `PAYLOAD_SECRET` also
invalidates sessions, order receipts and preview links.

---

## 3. Storefront behaviour

`PurchaseForm` renders a radio group when the site has enabled gateways, and renders exactly
what it did before Wave 10 when it has none.

- Ordered by `priority` ascending, then by gateway id. **The first is the default** — a stable
  tie-break matters, because an unstable one makes the default payment method change between
  requests.
- `kind: 'bnpl'` gets a **پرداخت اقساطی** badge. An instalment product is a different
  agreement, not a different button colour: the buyer is taking a loan and has to be told
  before they commit rather than on the PSP's own page.
- `mode: 'sandbox'` gets a loud badge. A shop left in sandbox takes orders that never settle.
- `minAmount` is shown beside the label, formatted in the site's currency.
- When the selected gateway `requiresMobile`, a hint appears under the phone field: Digipay and
  Snapp!Pay identify the wallet **by** that number, so a number that is not the buyer's own is
  a payment that cannot be collected.

The picker is a convenience over an allowlist, not the allowlist. Posting a `gateway` the site
does not have — or one whose window excludes this basket — is refused server-side with a fresh
`methods` array, which the form renders so the buyer can pick another without a reload.

### What the checkout body looks like

```jsonc
POST /api/checkout
{
  "product": "uuid",
  "quantity": 1,
  "name": "…",
  "phone": "09120000000",
  "email": "…",            // optional
  "note": "…",             // optional
  "gateway": "digipay",    // optional — omit and the site's own precedence decides
  "company": ""            // honeypot; a non-empty value is silently discarded
}
```

`total`, `unitPrice` and `currency` are never accepted from the client. The price comes from
the product row that was just read.

### Gateway precedence when `gateway` is omitted

1. The site has enabled gateways **and** `store.paymentProvider` is a *method* (`bank`/`http`)
   → the top-priority enabled gateway wins. Switching a gateway on is an explicit statement of
   intent, and `store.paymentProvider` is a default most tenants never visit — so a renderer
   that has not been updated to send `gateway` gets the merchant's new PSP rather than silently
   falling back to card-to-card.
2. Otherwise `store.paymentProvider`, exactly as in Wave 7.

---

## 4. API

All paths resolve the tenant from `Host`. `/api/payments/methods` is carved out in the
`Caddyfile` so a buyer's browser can reach it on the shop's own domain; **the other three are
not** — they are staff endpoints, reached from the control plane's origin, and a customer
domain routing to them would put a staff-only endpoint one `curl` away from anybody standing on
a shop's homepage.

### 4.1 `GET /api/payments/methods` — public

```
GET /api/payments/methods            → every enabled gateway
GET /api/payments/methods?amount=250000  → only those whose window contains 250 000 minor units
```

```jsonc
{
  "currency": "IRT",
  "defaultProvider": "bank",   // the site's configured method; null when it is itself a gateway
  "methods": [
    {
      "id": "digipay",             // post this back as `gateway`
      "label": "دیجی‌پی",
      "labelEn": "Digipay",
      "blurb": "پرداخت اقساطی دیجی‌پی…",
      "kind": "bnpl",              // or "psp"
      "mode": "live",              // or "sandbox"
      "priority": 100,
      "requiresMobile": true,
      "minAmount": 100000,         // site minor units, or null
      "maxAmount": null
    }
  ]
}
```

`amount` is optional because a product card does not know the quantity yet. **Omit it when
listing, pass it when the basket is known** — the checkout endpoint re-checks the window either
way. `400` for a non-integer or negative `amount`.

There is no row id, no credential and no site id in this shape, and no serializer between the
type and the response that could add one. The same list is in `GET /api/site` under
`payments.methods`, for a renderer that already bootstraps from there.

A `409` from `POST /api/checkout` also carries `methods`, so a refusal can re-render the picker.

### 4.2 `POST /api/payments/cancel` — site staff

```jsonc
{ "order": "uuid" }
```

Reverses a payment: Digipay `purchases/reverse`, Snapp!Pay `revert` then `cancel`. Takes an
**order**, not a gateway row — what a shop owner is undoing is a specific customer's payment,
and the gateway to ask is the one recorded on that order; deriving it from a row would let a
caller reverse a transaction against whichever credentials they named.

Authorised by asking Payload rather than by a hand-rolled role check: the row is read *without*
`overrideAccess`, so the collection's `read` access and the multi-tenant narrowing run
together. A site's staff and a site's own API key get through; everybody else gets a 404 for a
row that exists.

`501` when the provider has no reversal — **ZarinPal does not**, and an adapter that invented
one would be worse than one that says it cannot. `409` when the order was not paid through a
gateway.

On success the reversal is recorded in `orders.payment.gatewayData` and **the order status is
not touched.** Moving `paid` → `refunded` is the shop's decision in the admin: it changes what
the owner sees, may trigger stock handling, and may be wrong (a partial refund, a reversal the
PSP later fails to settle).

### 4.3 `POST /api/payments/self-test` — platform admin only

```jsonc
{ "id": "payment-gateways row uuid" }
```

Runs the adapter's read-only probe. **None of them creates a transaction**, because this runs
against a live merchant account.

| Gateway | Probe | Proves |
| --- | --- | --- |
| ZarinPal | `POST unVerified.json` | credentials valid; also reports how many unverified transactions are in the panel |
| Digipay | OAuth token | credentials valid |
| Snapp!Pay | OAuth + `GET offer/v1/eligible?amount=` | credentials valid, and the minimum instalment amount |
| Torob Pay | `POST {verifyPath}` with a dummy id | **reachability only** — Torob publishes no read-only endpoint, so a `200` here does not prove the credentials. The response says so rather than implying otherwise. |

Writes `selfTestOk`, `selfTestDetail` and `selfTestAt` back onto the row. Returns `502` with the
detail on failure, `501` if the gateway has no probe, `403` for anyone who is not platform
staff.

### 4.4 `GET /api/payments/status` — platform admin only

Module state, the allowlist, and per-gateway row/enabled counts across the platform. Not a
metrics dashboard — the answer to "a customer says their Digipay stopped working, is that us or
them?".

---

## 5. The callback

```
{siteOrigin}/api/checkout/callback?order={uuid}&gw={gateway}&st={hmac}
```

Built by `checkoutCallbackUrl()` on the **site's own origin**, because the `Host` of the
callback is how the tenant is re-resolved — a callback arriving on the control plane's host
belongs to no site and is refused.

- `order` — the only client-supplied fact used, re-read scoped to the site from `Host`.
- `gw` — must equal the order's stored provider or the request is refused. It means the URL was
  edited.
- `st` — `<issuedAt>.<hmac>`, an HMAC over `{ site, order, gateway, amount, issuedAt }`. One order, and it expires: the deadline is **inside** the signed payload, so it cannot be moved. Default window 30 minutes (`PAYMENT_GATEWAY_STATE_TTL_MS`), generous because an instalment flow can send a buyer through identity verification before it redirects back — and cheap to be generous about, since a replay cannot move money.

**`st` is not what makes an order paid.** `confirm` asks the PSP, server to server, and that is
the only thing that ever moves an order to `paid`. What the signature closes is narrower:
`/api/checkout/callback?order=<uuid>` is reachable by anyone who learns an order id, and
without `st` an attacker could drive the callback for an order they did not create, forcing a
verify against the PSP with whatever `providerId` or `authority` they chose to supply.

GET is the browser returning; POST is the PSP's own callback. Same verification, different
answer — a browser gets a redirect, a PSP gets a 2xx or it retries. Both are idempotent: a
retry cannot pay twice, move an order backwards, or settle stock again.

Values from the query string and body are handed to the adapter as `callback`, and adapters use
them for **lookups and cross-checks only** — which attempt is this, does the echoed amount
match the order, does the echoed `providerId` match what we stored. A value from a query string
is never the reason an order becomes `paid`.

---

## 6. Network policy

A gateway's base URL is a per-row setting, which means an administrator's typo decides where
this server sends a merchant's `client_secret`. `src/payments/gateways/net.ts` checks, in
order:

1. Scheme is `https:` — `http:` only with `PAYMENT_GATEWAY_ALLOW_INSECURE=true`, which sends a
   secret in cleartext and exists for a staging PSP behind a VPN.
2. Host is a **suffix** match against the descriptor's `allowedHosts` plus
   `PAYMENT_GATEWAY_EXTRA_HOSTS`. Suffix, not substring: `evil-zarinpal.com` and
   `zarinpal.com.attacker.tld` both fail.
3. Host is not an IP literal. No PSP's API lives at a bare address, and "the admin typed
   `169.254.169.254`" has no legitimate version.
4. Host does not resolve to a private, loopback or link-local address.

Step 4 is the one that matters and the one that is easy to drop. An allowlist cannot know that
`api.snapppay.ir` currently resolves to a cloud metadata endpoint; only the lookup can.
`PAYMENT_GATEWAY_SKIP_DNS=true` exists for tests pointed at a local mock and must never be set
in production.

Responses are capped at 256 kB, calls time out at `PAYMENT_GATEWAY_TIMEOUT_MS` (default 10 s),
and request headers and bodies are redacted before logging.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PAYMENT_GATEWAYS_KEY` | derived from `PAYLOAD_SECRET` | seals credentials; see §2.5 before rotating |
| `PAYMENT_GATEWAY_TIMEOUT_MS` | `10000` | a buyer is waiting on the checkout, so the default is short |
| `PAYMENT_GATEWAY_EXTRA_HOSTS` | — | comma-separated extra host suffixes, for a PSP that moves domain without a deploy |
| `PAYMENT_GATEWAY_ALLOW_INSECURE` | `false` | allow `http:` |
| `PAYMENT_GATEWAY_SKIP_DNS` | `false` | skip step 4 — tests only |
| `PAYMENT_GATEWAY_STATE_TTL_MS` | `1800000` | how long a callback signature stays valid. Raise it only if a provider's approval flow genuinely runs longer |

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No picker on the storefront | module off, gateway not allowlisted, row not `enabled`, credentials incomplete, or site currency not one the PSP settles in | `GET /api/payments/methods` on the shop's domain shows exactly what is offered; `GET /api/payments/status` shows the platform half |
| Picker appears, checkout refuses | the basket is outside the row's or the provider's amount window | the `409` carries a fresh `methods` list and a Persian reason |
| Self-test fails with a 401/403 | wrong credentials, or the merchant is on the PSP's sandbox while the row says `live` | check `mode` against the credentials entered |
| Snapp!Pay verifies but never settles | a `settle` marker is in `orders.payment.gatewayData` | the callback retries settle without re-charging; if it does not retry, run the callback URL by hand |
| Torob Pay self-test passes but payments fail | expected — the probe is reachability only (§4.3) | check `createPath`/`verifyPath` against what Torob support issued |
| Gateway vanished after a key rotation | every stored credential is unreadable | re-enter them (§2.5) |
| `unresolvable:…` or `resolves-to-private-address` in the logs | step 4 of the network policy | the base URL is wrong, or DNS is pointing at an internal address |

---

## 8. Adding a fifth gateway

Four files and one row, in this order:

1. `src/payments/gateways/types.ts` — add the id to `GatewayId`.
2. `src/payments/gateways/registry.ts` — a descriptor (endpoints per mode, `allowedHosts`,
   currencies, which catalogue keys are credentials vs settings, which are required) plus any
   new catalogue entries. `credentialFieldCatalogue` is presentation, `gatewayDescriptors` is
   behaviour; a key shared by two providers appears once in the first and twice in the second.
3. `src/payments/gateways/adapters/<name>.ts` — the translation.
4. `src/payments/gateways/adapters/index.ts` — one line.

`gatewayAdapters` is typed `Record<GatewayId, GatewayAdapter>`, so step 2 without step 4 is a
**compile error**, not a runtime `undefined` on somebody's checkout. The reverse — an adapter
with no descriptor — is caught by `tests/int/gateways.int.spec.ts`, which walks both tables and
compares them.

Then `pnpm payload migrate:create <name>` for the enum value, and add the new id to the
`payments` global's default allowlist.

**Do not** add a credential column by hand. Every key in `credentialFieldCatalogue` becomes a
column in `PaymentGateways` automatically, platform-admin-locked and masked on read; a column
added outside that path is a column nothing encrypts, and it stores plaintext.
