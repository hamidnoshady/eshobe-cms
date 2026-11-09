# POS-managed café menu (ESH-149 / #196)

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

## Checkout contract and remaining companion work

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

This change uses the existing payment gateway and signed receipt flow. **It does
not implement the separate café checkout issue #197 / ESH-150**: dine-in table
QR tokens, takeaway/counter payment, durable `order.submitted` events, and
checkout-request idempotency are still required before deploying the full POS
order-intake workflow. In particular, do not treat the draft cart as an order or
assume a lost checkout response is safe to resubmit. Biza's menu projection and
outbox implementation are tracked separately in biza-miz #1303 / ESH-145.
