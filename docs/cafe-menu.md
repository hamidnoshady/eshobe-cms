# POS-managed café menu and checkout (ESH-149 / #196, ESH-150 / #197)

This extends the existing `products`, `taxonomy-definitions`, `taxonomy-terms`,
`orders` and `productGrid`; it does not use the navigation `menus` collection or
install another commerce plugin. Apply the committed migration before deploying.
On a store page, select **منوی کافه و سبد خرید** in a Product Grid block. The
ordinary Product Grid mode remains the default. The café mode shows published
Biza products and the `cafe_menu_category` taxonomy for the current site, ordered
by `menuOrder` and then stable source ID. The client cart is an in-memory draft;
refreshing or navigating away clears it. It shows estimates only.

## Sync contract

The following control-plane endpoints require a **site** API key. They are not
public Caddy carve-outs; a platform key, anonymous request, or a site ID in the
body does not authorize a different tenant. The site comes from the credential.
Source IDs must be 1–128 characters from `A-Z a-z 0-9 . _ : -`; they must not be
recycled. Products and categories are uniquely indexed by `(site,
menuSourceSystem, menuSourceId)` in PostgreSQL. Repeat the same PUT after a lost
response; the response contains the same CMS `id`. A concurrent first create can
return `409`, in which case retry. Never match by name, SKU or slug. An existing
source identity and its site cannot be changed.

The reserved `cafe_menu_category` taxonomy is also database-unique per site.
The migration backfills its internal identity without changing unrelated taxonomy
keys. If a site already has multiple definitions with that reserved key, resolve
the duplicates before running the migration; it deliberately fails rather than
choosing or deleting one.

`PUT /api/site/cafe-menu/categories/:sourceId`:

```json
{ "name": "قهوه", "description": "نوشیدنی گرم", "menuOrder": 10, "parentSourceId": null, "locale": "fa" }
```

`name` is required on every category write. `parentSourceId` must name another
category on the same site; `null` clears a parent. The dedicated taxonomy is
created if absent. Category names/descriptions are localized; a locale must be
enabled on the site.

`PUT /api/site/cafe-menu/products/:sourceId`:

```json
{
  "title": "لاته",
  "summary": "اسپرسو و شیر",
  "price": 125000,
  "sku": "LATTE",
  "image": "<same-site media UUID>",
  "menuOrder": 20,
  "menuAvailability": "available",
  "trackInventory": true,
  "inventory": 6,
  "categorySourceIds": ["coffee"],
  "modifierGroups": [
    {
      "sourceId": "milk", "label": "نوع شیر", "minSelections": 1,
      "maxSelections": 1, "active": true, "menuOrder": 1,
      "options": [
        { "sourceId": "regular", "label": "معمولی", "priceDelta": 0, "active": true, "menuOrder": 1 },
        { "sourceId": "oat", "label": "جو", "priceDelta": 20000, "active": true, "menuOrder": 2 }
      ]
    }
  ],
  "locale": "fa"
}
```

`title` and `price` are required for a new product. Omitted fields on an update
are left unchanged. When supplied, `categorySourceIds` replaces the menu-category
links (other taxonomy links are retained), and `modifierGroups` replaces the
complete POS group/option projection. Group IDs must be unique within the product;
option IDs within the group. The sync preserves Payload array row IDs by source ID,
including when the order changes, so a write in one locale retains other locales.
All amounts, including signed `priceDelta`, are integer **minor units of the site
currency**, not strings or floats. An option may be selected at most once per item;
line quantity multiplies its delta. Required means `minSelections > 0`.

`menuAvailability` is `available`, `sold_out`, or `unavailable`, independent of
`_status` and stock tracking. Disable an item by updating this field even if it is
published. A tracked-but-unknown stock value is not treated as unlimited;
`trackInventory: false` does not manufacture a zero quantity. Biza products are
marked `externalInventory`: staff cannot edit their mirrored stock and CMS payment
or refund settlement will not change it. Biza must publish authoritative stock
updates using the site key. Non-POS products retain ordinary CMS stock settlement.

The sync cannot publish content: creates are **drafts**, `_status` is rejected,
and publishing remains an existing owner/operator action. Updating a published
record does not unpublish it. The integration must opt products into publication
through the existing authorized workflow. Image IDs must be from the same site.
The POS outbox must re-read current desired data on retries and serialize writes
for an item: these endpoints provide stable identity, not source-version ordering.

## Cart checkout contract (ESH-148 / #195)

`POST /api/checkout` retains the legacy `{product, quantity, ...buyer}` form. A
cart sends `items` (1–50 lines), `name`, `phone`, optional `email`, `note`,
`locale`, `gateway`, and the hidden `company` honeypot:

```json
{
  "name": "خریدار", "phone": "09123456789",
  "items": [
    { "product": "<CMS product UUID>", "quantity": 2,
      "modifiers": [{ "groupId": "milk", "optionIds": ["oat"] }] },
    { "product": "<another CMS product UUID>", "quantity": 1, "modifiers": [] }
  ]
}
```

A line may also include a stable `variation` key for a genuinely variable
product. Checkout resolves the tenant from `Host`, re-reads each published
product, checks availability and aggregate stock, validates every modifier against
its current active definition, and calculates all prices on the server. Unknown,
duplicate, inactive, or out-of-bounds selections fail. Submitted prices and totals
are ignored. Lines snapshot product/variation/modifier names, IDs, signed deltas,
quantities and external stock ownership; the old first-line fields remain a mirror.
Coupons continue to work on the legacy single-product request, but are explicitly
rejected for cart requests until a multi-line coupon allocation is designed.

## Café checkout: dine-in, takeaway and pay at the counter (ESH-150 / #197)

The cart contract above is the base. A café order adds four optional fields, and
sending any one of them puts the request on the café path:

```json
{
  "name": "میزبان", "phone": "09123456789",
  "checkoutRequestId": "9f2c1a4e77b04d0f8c31ab77e0d5",
  "serviceMode": "dine_in",
  "tableToken": "<opaque Biza token from the QR link, verbatim>",
  "paymentChoice": "counter",
  "items": [{ "product": "<CMS product UUID>", "quantity": 1,
              "modifiers": [{ "groupId": "milk", "optionIds": ["oat"] }] }]
}
```

**Service mode.** `dine_in` requires `tableToken`; `takeaway` must not carry one.
Delivery and reservation modes are not offered and are rejected rather than
coerced. The token is opaque to this CMS: it is length/charset-checked, stored
verbatim and handed to Biza, which resolves it against its own business,
location and table records. The CMS never stores a table id, never derives one
from the token, and never answers a request that asks whether a token is valid —
that answer would let anyone probe another tenant's tables. `?t=<token>` on a
site page reaches the menu block as a prop and only decides whether dine-in is
selectable; the endpoint re-validates the value regardless.

**Payment choice.** `counter` creates a normal pending/unpaid order with the
`counter` payment provider, makes no gateway call at all and returns the signed
receipt URL immediately. `online` keeps the existing gateway path unchanged, and
a paid status is only ever set from a verified provider confirmation. A query
string, a client flag or a webhook body cannot mark an order paid.

**Idempotency.** `checkoutRequestId` is a client-generated opaque string (8–128
characters) and is **required** on the café path: without it the endpoint cannot tell a
lost response from a second order, so a café request that omits it is refused (HTTP 400)
rather than guessed at. The merchant storefront always sends one. `(site, checkoutRequestId)` is unique, and the order stores a
`cartFingerprint` of the basket it was created from. The same id with the same
fingerprint is a retry and returns the existing order (HTTP 200, `"retry": true`,
same `orderId`); the same id with a different basket is HTTP 409 and no order is
created; a new id is a new order, so two colleagues at one table ordering from
one phone number are both served. A unique-constraint collision between two
concurrent requests is resolved by re-reading the winner. Retrying a *lost
response* therefore cannot create a second CMS order, which is what makes the
outbound event safe to replay.

The cart is subject to the ordinary site rate limit; a submitted order is not.

### Events

`order.submitted` fires once, on create, for every café order — `pending` or paid
— over the existing signed webhook fan-out and on the poll feed (id
`order:submitted:<orderId>:<createdAt>`). Payload:

```json
{
  "orderId": "<CMS order id>", "reference": "CMS-1042", "eventVersion": 1,
  "serviceMode": "dine_in", "tableToken": "<verbatim>",
  "fulfillment": "awaiting_approval", "paymentProvider": "counter",
  "paymentStatus": "pending", "total": 950, "currency": "IRT"
}
```

Only identity and state travel: Biza fetches the full document through its
site-scoped API key, so there is exactly one authoritative copy of the line
snapshots. `order.paid`, refund and cancellation events keep their existing
meaning and their existing CMS order id, so a POS can converge them onto one
order.

`order.paid` is **suppressed** for café orders when the CMS did not take the
money: `payment.provider === 'counter'` settlements and status writes that
arrived with a site API key (the POS writing back what it already knows) emit
nothing. Without that guard the POS's own counter-settlement write would bounce
back to it as a payment it never took. A verified online payment, and an
operator marking a transfer paid in the admin, still emit.

### Stock ownership

The POS owns recipe and ingredient inventory. Any order that carries a café
service mode decrements no CMS product stock when it is paid — including lines
for CMS-owned products, because the ticket is fulfilled by the POS end to end.
Products the menu sync creates are also marked `externalInventory`, so they are
skipped individually even on an ordinary store order. Ordinary store products on
an ordinary store order, and coupon usage, behave exactly as before.

### Receipt

The customer receipt shows three independent lines, because they are three
independent lifecycles: service type (`cafe.serviceMode`), preparation
(`cafe.fulfillment`, driven by the POS), and payment (`status`). `cafe.fulfillment`
defaults to `awaiting_approval` and is a closed vocabulary
(`awaiting_approval`, `accepted`, `preparing`, `ready`, `served`, `rejected`).

The POS writes it through its site key with an ordinary order update
(`PATCH /api/orders/:id`, `{ "cafe": { "fulfillment": "accepted" }, "status": "paid" }`).
A site key may write exactly two things on an order: `status` and
`cafe.fulfillment`/`cafe.fulfillmentAt`. Every other field — totals, buyer, reference,
the café service mode and token, the checkout request id — reverts to the stored value,
so an overreaching or compromised key cannot rewrite a receipt. A `fulfillment` value
outside the vocabulary is dropped from a keyed write rather than failing the whole
update, because `status` in the same call is the POS's real assertion.

Biza's companions: table QR tokens in biza-miz #1305, submitted-order intake and
per-connection idempotency in #1304, and the menu projection in #1303.
