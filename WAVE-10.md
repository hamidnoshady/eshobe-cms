# Wave 10 — Iranian payment gateways

Wave 7 gave the store two ways to take money: `bank` (card to card, confirmed by a human)
and `http` (POST to whatever settlement service a site runs itself). Both are honest about
what they are, and neither is a payment service provider. This wave adds the four PSPs an
Iranian shop actually contracts with — **ZarinPal, Digipay, Snapp!Pay and Torob Pay** — as a
module that can be switched off, configured per tenant, and reached from the API without ever
handing back a credential.

Operator and headless documentation lives in `docs/payment-gateways.md`. This file is the
decision record: what was chosen, what was rejected, and why the shape is the shape it is.

---

## 1. What was asked for, and what that decided

Four answers were given before any code was written, and every structural choice below
follows from one of them.

| Answer | Consequence |
| --- | --- |
| Ship the gateways as a **toggleable module**, per tenant, in the CMS admin. (Not an LMS — `lm` meant "them".) | A `payments` global holds the platform-wide switch; a `payment-gateways` collection holds one row per (site, gateway) with the tenant's own `enabled`. Two switches, two owners. |
| ZarinPal, Digipay, Snapp!Pay, Torob Pay. | Four adapters, one contract (`src/payments/gateways/types.ts`). The differences between them are field names and auth, not lifecycle. |
| Torob Pay has **no public documentation**, so it gets a **config-driven adapter**. | Per-row base URL and endpoint paths. `torobPay.ts` says so in its header rather than inventing a contract and presenting it as Torob's. |
| Credentials are entered by a **platform admin**, AES-encrypted with `PAYLOAD_SECRET`, and **never returned by any API**. Tenant owners only toggle and order. | Real encrypted columns, field access locked to platform staff, *and* an `afterRead` hook that blanks the value for everyone. Belt and braces, because either alone has a hole. |
| The **buyer picks the gateway at checkout**; a tenant may enable several, ordered. | The largest change here is not the adapters — it is `startCheckout`, the storefront picker, and an order that records which gateway took it. |

---

## 2. Four adapters, one lifecycle

Every Iranian PSP in scope makes the same four moves: open a transaction, send the buyer to a
URL, read what came back, ask the PSP itself whether the money moved. So the shape lives in
`src/payments/gateways/types.ts` and each adapter is a translation of it.

```
GatewayAdapter = { id, initiate, confirm, cancel?, healthCheck? }
GatewayContext = { credentials, settings, descriptor, mode, order, callbackUrl, callback?, req, rowId }
```

| Gateway | Kind | Initiate | Confirm | Cancel | Health check |
| --- | --- | --- | --- | --- | --- |
| **ZarinPal** | psp | `POST /pg/v4/payment/request.json` → redirect to `StartPay/{authority}` | `POST verify.json`, success is code `100` or `101` (already verified) | none — ZarinPal has no reversal API, and the adapter says so instead of inventing one | `POST unVerified.json` |
| **Digipay** | bnpl | OAuth password grant → `POST tickets/business?type={ticketType}` with `Agent` + `Digipay-Version` | `POST purchases/verify?type={callbackType}` | `POST purchases/reverse` (staff only) | OAuth token |
| **Snapp!Pay** | bnpl | OAuth (`scope=online-merchant`) → `POST payment/v1/token`, `INSTALLMENT` cart | `verify` **then** `settle` | `revert`, falling back to `cancel` | `GET offer/v1/eligible?amount=` |
| **Torob Pay** | bnpl | `POST {createPath}` — base URL required, no published default | `POST {verifyPath}` | `POST {cancelPath}` | reachability only, and labelled as such |

Three details worth recording, because each one is a decision a future reader will otherwise
re-litigate:

**Snapp!Pay settles in two calls.** `verify` confirms the buyer's instalment plan; `settle`
is what moves money to the merchant. An adapter that stops at `verify` produces orders that
read as paid in our database and never appear in the merchant's settlement. So `confirm`
verifies and then settles — and if the settle fails *after* a successful verify, it returns
`ok: false` with a `settle` marker in `gatewayData` rather than `ok: true`. A PSP callback
that retries then settles without re-charging, which is the only idempotent shape available.

**Torob Pay's `paid()` requires an affirmative marker.** Torob publishes nothing, so the
adapter accepts the field names the documented providers use (`status`, `state`, `result`,
`success`, …) and refuses to treat HTTP 200 as payment. A gateway that returns `200 { }` for
"received" would otherwise mark every order paid. The same adapter cross-checks the echoed
`reference` and `providerId` against what was stored before it verifies, and sends the
*stored* reference — never the one from the query string.

**Amounts are Rial or Toman and nothing else.** `src/lib/money.ts` remains the only place
that knows 1 Toman = 10 Rial. An order carries a snapshot of its site's currency, adapters
convert with `amountIn`, and `amountMatches` compares a PSP's reported figure in Toman
against the order in Toman. A ten-times error here is the single most expensive bug this
module can contain, which is why the conversion is one function and the comparison is
another, and both are tested.

---

## 3. Two switches, and why the order matters

```
platform `payments` global        tenant `payment-gateways` row
  moduleEnabled          ──┐        enabled
  allowedGateways        ──┴──▶     credentials complete?     ──▶  offered / refused
                                    amount window contains it?
```

Both are checked in one place — `resolveGateway()` in `src/payments/gateways/resolve.ts` —
because three switches checked in three files is three chances for one to be forgotten. The
platform's answer comes first: a PSP the operator has not contracted with, has dropped, or is
having an outage with comes out of `allowedGateways` and every tenant's row for it stops
resolving, **without anyone editing a customer's configuration**.

Turning the module off stops *new* attempts. It deliberately does not stop an in-flight one
from being verified: refusing to ask a PSP whether money moved would strand a paid order, and
"the module is off" is not a reason to lose a customer's payment.

The defaults are permissive on the global (`moduleEnabled: true`, all four allowed) because
the dangerous defaults are elsewhere: a row's `enabled` is `false` at creation, only a
platform admin can write a credential, and a row with none is refused. Nothing transacts
until somebody has deliberately configured it.

### Refusals are coarse on purpose

`resolveGateway` returns a discriminated union whose `reason` is shown to a buyer, and the
reasons are deliberately vague — «این روش پرداخت در این سایت فعال نیست» rather than «the
merchant id is malformed». The specific detail goes to the log. A public checkout that
explains *how* a gateway is misconfigured is a free probe into which of the platform's
customers hold which PSP accounts.

---

## 4. Credentials: three layers, because one has a hole

The requirement was "encrypted in the database and never returned by any API". Those are two
different threats and they need two different mechanisms.

1. **Encrypted at rest.** `enc:v1:<base64url(iv ‖ tag ‖ ciphertext)>`, AES-256-GCM, key
   scrypt-derived from `PAYMENT_GATEWAYS_KEY` or `PAYLOAD_SECRET`. A fresh IV per
   encryption, so two tenants with the same merchant id do not have the same ciphertext.
   A database dump, a stolen backup or a SQL injection elsewhere in the stack gets
   ciphertext.
2. **Field access.** `create`/`read`/`update` on every credential column is
   `platformAdminFieldAccess`. A tenant's editor cannot write one and cannot ask for one.
3. **An `afterRead` hook that blanks the value.** This is the layer that makes "never
   returned by any API" literally true, including for a platform admin, including through
   GraphQL, including in an admin UI list view. It yields unless
   `req.context[SECRET_READ_CONTEXT_KEY]` is set, and only `resolve.ts` sets that.

Layer 3 is not redundant with layer 2. Field access decides *who may ask*; the hook decides
*what comes back*. Ciphertext that any authenticated editor can read is a plaintext with
extra steps, and `overrideAccess: true` — used all over this codebase for legitimate reasons
— bypasses layer 2 entirely. A context flag only one module sets cannot be widened by a
future change to field access.

### Why real columns and not `virtual: true` fields

Virtual fields were the obvious design: a credential is write-only, so why give it a column?
Because Payload forces `admin.readOnly = true` on a virtual field unless explicitly
overridden, never persists it, and leaves "where does the ciphertext live" to a `beforeChange`
hook that has to know the column layout anyway. Real `text` columns holding ciphertext are
simpler, survive a `select`, and are visible in a database inspection — which is a feature
when the question is "is this row actually configured?".

### Why blank means "unchanged"

Because the fields render empty (layer 3), every save submits them empty. If blank meant
"delete", editing a row's `priority` would wipe the merchant's `client_secret`. So the
encrypting hook merges typed values over a re-read of the stored ciphertext, and
`clearCredentials` is the explicit door for wiping a row.

The re-read is `findByID` with `overrideAccess` and the secret flag, not `originalDoc`:
the update operation's copy has already been through field access and the masking hook, so
its credential values are whatever the caller was allowed to see.

### What a platform admin can see instead

`credentialsSummary` — how many fields are set, plus a 12-hex-char HMAC fingerprint of each.
The fingerprint is stable across renders (so "did that save?" is answerable) and cannot be
reversed (48 bits over a value nobody can enumerate). It is not a leak and it is not a guess.

---

## 5. The buyer picks

This is the change that touches the most existing code.

`startCheckout` now resolves a gateway **before** creating the order, so a stale picker
cannot leave a `pending` row behind that the duplicate guard then holds against the buyer for
fifteen minutes. The precedence:

1. `gateway` in the request body, if the buyer's form sent one. Refused with a fresh
   `methods` list if this basket cannot use it — the server knows the amount, so the server
   sends the list.
2. Otherwise, if the site has enabled gateways and `store.paymentProvider` is a *method*
   (`bank`/`http`), the top-priority enabled gateway wins. Switching a gateway on is an
   explicit statement of intent, and `store.paymentProvider` is a default most tenants never
   visit — so a headless renderer that has not been updated to send `gateway` gets the
   merchant's new PSP instead of silently falling back to card-to-card.
3. Otherwise `store.paymentProvider`, exactly as before.

With no gateway enabled anywhere, step 3 is what runs and the checkout is byte-for-byte the
Wave 7 flow.

The order records `payment.mode` (`live`/`sandbox`, snapshotted because the row can be flipped
afterwards) and `payment.gatewayData` — whatever the PSP handed back that a reconciliation
needs: Digipay's ticket, ZarinPal's `ref_id`, Snapp!Pay's `orderId`, a settle marker. The
column denies writes at field level and is written only under `overrideAccess`, because it is
the adapter's account of what the PSP said rather than a tenant's opinion of it.

### The callback is signed

`checkoutCallbackUrl` puts `order`, `gw` and `st` on the URL, where `st` is
`<issuedAt>.<hmac>` over `{ site, order, gateway, amount, issuedAt }`. It is **not** what
decides `paid` — `confirm` asks the PSP, server to server, and that is the only thing that
ever moves an order to `paid`. What the signature closes is narrower:
`/api/checkout/callback?order=<uuid>` is reachable by anyone who learns an order id, and
without `st` an attacker can drive the callback for an order they did not create. A `gw` that
disagrees with the order's stored provider is refused outright.

The timestamp is *inside* the signed payload, so the deadline cannot be moved by whoever holds
the URL. Unlike an order receipt — which is a document a buyer keeps, and so deliberately never
expires — a callback URL lands in a PSP's request log, a proxy's access log and a browser's
history, and should not stay drivable forever. The default window is 30 minutes
(`PAYMENT_GATEWAY_STATE_TTL_MS`) and is generous on purpose: an instalment flow can send a
buyer through identity verification and a four-step approval before it redirects back, and a
signature that expires mid-flow turns a completed payment into a support ticket. Generous is
cheap here precisely because a replay cannot move money — `confirm` is idempotent.

---

## 6. Reachability

`/api` is blocked on customer domains by Caddy except for a short list of carve-outs. One was
added, and only one:

```
@payment_methods { method GET HEAD; path /api/payments/methods }
```

The buyer's picker has to be drawable from the shop's own domain, and the answer is as public
as the shop's prices: labels, blurbs, amount windows, whether a mobile number is mandatory.
`EnabledGateway` has no field for a row id and no field for a credential, so there is no
serializer between that type and the response that could widen it.

`POST /api/payments/self-test` and `POST /api/payments/cancel` are deliberately **not** carved
out. The first makes this server call a live merchant account and is platform-admin only; the
second moves money back and is site-staff only. Both are reached from the control plane's own
origin, and letting a customer domain route to them would put a staff-only endpoint one `curl`
away from anybody standing on a shop's homepage. They fall through to `@control_plane_paths`
and get a 404.

The methods list is also in `GET /api/site`, because a headless renderer already makes that
call before it can render anything and a second round trip would draw the picker *after* the
buy button — which is exactly when a buyer notices.

---

## 7. SSRF, and why the allowlist is not the whole defence

A gateway's base URL is a per-row setting, which means a platform admin's typo decides where
this server sends a merchant's `client_secret`. `net.ts` therefore checks four things, in
order: scheme is `https:` (or `http:` only with `PAYMENT_GATEWAY_ALLOW_INSECURE=true`); the
host is a **suffix** match against the descriptor's `allowedHosts` plus
`PAYMENT_GATEWAY_EXTRA_HOSTS` — so `evil-zarinpal.com` and `zarinpal.com.attacker.tld` both
fail; the host is not an IP literal; and it does not resolve to a private, loopback or
link-local address, `169.254.169.254` included.

The DNS check is the one that matters and the one that is easy to drop. An allowlist cannot
know that `api.snapppay.ir` currently resolves to a metadata endpoint; only the lookup can.
`PAYMENT_GATEWAY_SKIP_DNS` exists for tests pointed at a local mock and is documented as
never-in-production.

Request headers and bodies are redacted before logging. A credential may exist in plaintext
inside one adapter call and nowhere else — not in an error message, not in a log line, not in
a response.

---

## 8. What is deliberately not here

- **No webhook receiver.** Every PSP in scope answers a synchronous `verify`. A webhook
  endpoint is a second way to be told something already known, and a second surface to
  authenticate.
- **No refunds beyond `cancel`.** `POST /api/payments/cancel` reverses a payment and records
  that it did; it does not move the order's status. Turning a `paid` order into `refunded`
  changes what the owner sees, may trigger stock handling, and may be wrong — that is a
  person's decision in the admin.
- **No re-encryption job.** Rotating `PAYMENT_GATEWAYS_KEY` or `PAYLOAD_SECRET` invalidates
  every stored credential. A platform admin re-enters them; a row whose secrets no longer
  decrypt is refused with a Persian message rather than failing at the PSP. Documented in
  `.env.example` next to the key itself, because that is where somebody will be reading when
  they rotate it.
- **No Stripe.** Unchanged from Wave 7, and for the same reason: Iran is not a
  Stripe-supported country for opening a merchant account, and `IRR`/Toman are not Stripe
  presentment currencies.
- **No cart.** One product, one quantity, one order — as Wave 7 established. Snapp!Pay's
  `cartList` and Digipay's `basketDetailsDto` are built as single-item baskets, which is the
  only honest description of what this platform's orders are.

---

## 9. Tests

`tests/int/gateways.int.spec.ts` — 57 assertions, no database. It exists because everything
that can break here breaks by editing a table, and a test that needs Postgres to notice a typo
in a registry does not run in the loop where the typo happens.

It covers: registry ↔ adapter completeness in both directions (a descriptor with no adapter is
`undefined` at checkout); catalogue key ↔ database column in both directions (a key with no
column silently stores nothing, a column with no key silently stores *plaintext* because
nothing encrypts it); every credential column is platform-admin-locked, masked on read, and
not `required` (Payload validates required fields even when `admin.condition` hides them, so a
required Snapp!Pay field would make every ZarinPal row unsavable); every endpoint is `https`
and inside its own host allowlist; Toman↔Rial conversion and cross-unit amount matching;
private-address recognition including IPv4-mapped IPv6; the suffix-match allowlist;
encrypt/decrypt round-trips, IV uniqueness, wrong-key behaviour and pass-through of a
never-sealed value; callback state signature round-trip, expiry, and every tampering that matters; and
the `beforeChange` hook order, asserted on the array by function identity rather than by
scanning source (a scan finds the first *mention* of a name, and all four are mentioned in the
comment above the array).

The DB-backed paths — row creation, the encrypting hook, masking through the REST API, the
module switch, a checkout with a gateway — belong in `tests/int/store.int.spec.ts` beside the
existing checkout specs.
