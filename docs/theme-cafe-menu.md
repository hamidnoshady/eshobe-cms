# Building a menu theme for the POS-managed café menu

**For theme developers (human or agent) building a storefront for a café whose menu
is owned by Biza Miz** — or by any other POS that speaks the same sync contract.

This is the *theme* side of the story. It collects the whole wire end to end: what
the CMS stores, what it sends you, what you must send back, how a table QR
reaches dine-in, what the receipt has to say, and the mistakes that cost a live
café a day of debugging. Read this before writing a block renderer or a cart.

Companions, and what they are for:

| Document | Owns |
|---|---|
| [`THEME_API.md`](./THEME_API.md) | The platform contract: descriptor, collections, money, media, routing, checkout in general |
| [`cafe-menu.md`](./cafe-menu.md) | The **sync** contract: how the POS pushes categories, products and modifiers into the CMS, and the order/state endpoints it calls |
| [`THEME_SETTINGS_STANDARD.md`](./THEME_SETTINGS_STANDARD.md) | Theme settings UI, tokens, typography |
| [`theme-deployments.md`](./theme-deployments.md) | How a theme repo becomes a running container |

Reference implementations, both in this platform:

- the CMS's own block renderer — `src/blocks/ProductGrid/CafeMenu.tsx` +
  `CafeMenuClient.tsx`;
- the Coffee Poster café theme — `alifarjoodi/cms-resturant-2-theme` (a plain Node
  SSR theme with a cart, add-ons and table-QR dine-in). It is the worked example
  every rule below was learned from.

---

## 1. The shape of the problem

A café menu is not a product catalogue with an unusual skin. Three things differ:

1. **The POS owns the menu.** Names, prices, stock, categories, order and "sold
   out" are pushed from Biza Miz and can change between two page loads. The CMS is
   a mirror with a stable identity for each item, not the source of truth.
2. **An item has add-ons that change its price.** A latte with oat milk is a
   different amount from a latte, and only the CMS may price it.
3. **The order carries how it was ordered** — at a table (from a printed QR), or
   takeaway — and how it will be paid — at the counter, or online.

A theme that renders `products` as cards and POSTs the legacy single-product
checkout can look right and be wrong in every one of those three ways. On
`cafe1.eshobe.com` it was: items in `-createdAt` order, sold-out guessed from
inventory, add-ons invisible, and a checkout that asked the CMS for a tenant it
could not resolve.

---

## 2. What the CMS gives you

### 2.1 The site must be a `store`

`GET /api/site` → `type: "store"`. Two consequences, and both are load-bearing:

- `blocks` includes `"productGrid"` **only** for a store site. The CMS also
  refuses to save a `productGrid` block on a business/portfolio site, so this is
  not merely a client-side list.
- A renderer that switches on `site.type === 'store'` for its menu page will
  render nothing for a café that was created as a portfolio. Check the type
  before you debug your template.

The descriptor also carries `store.currency` (the site's selling unit — `IRT` for
Toman), `payments.methods`, `availableLocales`, `defaultLocale`,
`themeRuntime.bindings.home` and `contractVersion: 1`.

### 2.2 The block

`pages_blocks_product_grid` holds `mode` (`catalog` | `cafe`), `populateBy`
(`collection` | `selection`), `limit`, `columns`, `showBuyButton`, plus a localized
`heading`/`intro`.

- `mode: "cafe"` is the café projection: products ordered by **POS category then
  accounting order**, categories and availability treated as below.
- `limit` maxes at **100**. A menu can be longer than the poster design;
  request the whole menu and let the layout scroll rather than silently dropping
  items (24 was the old cap, and on a 29-item menu five items vanished).

If the site's `themeRuntime.bindings.home` points at a page, that page's layout is
what renders — a bound home page **with no `productGrid` block** renders an empty
menu. That is the single most common "the theme shows nothing" cause.

### 2.3 The product

`GET /api/products?where[_status][equals]=published&locale=fa` (a site key may read
drafts, so always state the filter yourself):

```jsonc
{
  "id": "6d115861-…",
  "title": "اسپرسو سینگل",           // localized
  "summary": "",
  "slug": "cafe-item-209392d0…",
  "price": 140000,                   // integer minor units of site.store.currency
  "compareAtPrice": null,
  "sku": "",
  "image": null,                     // media id; depth ≥ 1 gives the document
  "trackInventory": true,
  "inventory": 2,
  "externalInventory": true,         // POS owns this stock: CMS payment never moves it
  "menuSourceSystem": "biza_miz",    // present on every POS-managed item
  "menuSourceId": "menu_item:0966a674-…",
  "menuAvailability": "available",   // available | sold_out | unavailable
  "menuOrder": 4,
  "modifierGroups": [ /* §2.4 */ ],
  "terms": [ /* the café category, §2.5 */ ]
}
```

`menuSourceSystem` is the cheapest way to answer "is this a café item?" — it is
what tells you to use the cart rather than the one-product form.

### 2.4 Add-ons (`modifierGroups`)

```jsonc
"modifierGroups": [
  {
    "sourceId": "0c613122-61a1-446c-8940-586cc2db9374",  // stable; what checkout takes
    "label": "تاپینگ",                                    // localized
    "minSelections": 0,
    "maxSelections": 999,          // see the sentinel below
    "active": true,
    "menuOrder": 0,
    "options": [
      { "sourceId": "64f7b80c-…", "label": "شکلات تلخ", "priceDelta": 20000, "active": true, "menuOrder": 1 }
    ]
  }
]
```

Rules, all of them enforced again at checkout:

- **`999` is a POS word for "no limit".** It is not a real bound: a group can
  never take more choices than it has options. Cap `max` at `options.length` when
  you render, or the buyer is offered freedom that checkout refuses.
- `active: false` on a group or an option means retired. Hide it; never submit it.
  A group whose options are all retired is not a group.
- A group with no options at all is not renderable and not orderable — do not
  invent an empty control.
- `priceDelta` is **signed integer minor units**, and an option may be chosen at
  most **once per item**. Line quantity multiplies the sum — never the other way
  round.
- `minSelections > 0` means required. Disable "add to order" until it is met; the
  CMS refuses the line otherwise, and the buyer sees a generic failure.

### 2.5 Categories

Categories are `taxonomy-terms` of the reserved taxonomy `cafe_menu_category`,
linked through the product's `terms`. Each term carries `name`, `menuOrder` and
`menuSourceId`.

Sort by **term `menuOrder`**, then item `menuOrder`, then the stable source id —
that is the printed menu's order. `-createdAt` is meaningless here: every mirrored
row was created in the same minute, so it is effectively random.

### 2.6 Availability

`menuAvailability` and stock are one decision, and the theme must make it the same
way the CMS does (`src/lib/cafe-menu.ts` → `menuAvailability`):

```
sold_out        if menuAvailability === 'sold_out'
unavailable     if menuAvailability is set and is not 'available'
unavailable     if trackInventory and inventory is not a non-negative integer
sold_out        if trackInventory and inventory === 0
available       otherwise
```

A tracked product with **no** inventory figure is *unavailable*, not unlimited.
`externalInventory: true` means the POS settles the stock; the CMS will not move
it, and a paid order must not appear to.

---

## 3. The order you send

`POST /api/checkout`. Through a theme with `proxiesApi: true`, that is a **same-origin**
request to your own `/api/checkout`; the CMS decides the tenant from `Host`.

```jsonc
{
  "items": [
    { "product": "<CMS product id>", "quantity": 2,
      "modifiers": [{ "groupId": "0c613122-…", "optionIds": ["64f7b80c-…"] }] }
  ],
  "name": "میزبان", "phone": "09121234567", "company": "",      // company = honeypot
  "checkoutRequestId": "9f2c1a4e77b04d0f8c31ab77e0d5",
  "serviceMode": "dine_in",
  "tableToken": "<opaque token from the QR, verbatim>",
  "paymentChoice": "counter",
  "locale": "fa",
  "note": "بدون شکر"
}
```

- **1–50 lines.** Prices, totals and modifiers are recalculated server-side; a
  submitted price is ignored.
- `couponCode` works on the **legacy single-product** form only. A cart request
  that carries one is rejected — if the shop needs coupons, keep the legacy path
  for its plain products.
- `checkoutRequestId` is **required on the café path**: 8–128 characters,
  `^[A-Za-z0-9._:-]+$`. It belongs to the *basket*: the same id + the same basket
  fingerprint is a retry (200, `retry: true`, same order), the same id with a
  different basket is `409`, and a new basket needs a new id.
- `serviceMode: "dine_in"` **requires** `tableToken`; `"takeaway"` **must not**
  carry one. Delivery and reservation are refused, not coerced.
- `paymentChoice: "counter"` creates an unpaid order with the `counter` provider,
  calls no gateway, and returns the signed receipt immediately. `"online"` keeps
  the gateway path. Payment status is only ever set from a verified provider
  confirmation — never from a query string, a flag or a webhook body.

Response:

```jsonc
{ "ok": true, "orderId": "…", "reference": "ESH-78174447",
  "confirmationUrl": "/checkout/<id>?r=<sig>", "redirectUrl": null }
```

Plus `409` (basket changed / amount mismatch / conflict), `429` (rate limit, cart
only — a submitted order is not limited), `400` (validation).

### 3.1 The one request rule that breaks silently

**`fetch()` cannot send a `Host` header.** It is a forbidden request header in the
Fetch standard, and Node's undici follows the spec: it derives `Host` from the URL
and drops whatever you pass. A theme that proxies visitor writes with
`fetch(cmsUrl, { headers: { Host: req.headers.host } })` sends `Host: <cms origin>`
instead, the CMS cannot resolve a tenant, and checkout answers
`400 {"message":"unknown host"}` — for every order, with the cart code looking
perfectly correct.

Send visitor writes with `node:http` / `node:https`:

```js
import http from 'node:http';
import https from 'node:https';

const sendWithHost = (target, { method, headers, body }) => new Promise((resolve, reject) => {
  const url = new URL(target);
  const transport = url.protocol === 'https:' ? https : http;
  const payload = body ? Buffer.from(body) : null;
  const request = transport.request({
    protocol: url.protocol, hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`, method,
    headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
  });
  request.on('error', reject);
  if (payload) request.write(payload);
  request.end();
});
```

Reads may keep using `fetch` — they are key-scoped, and streaming a media file
through a buffer just to fix a header is a poor trade.

Never attach `ESHOBE_API_KEY` to visitor traffic, and never forward their cookies.

### 3.2 Never render a `company` field

The CMS's anti-bot honeypot is a field named **`company`**. A non-empty value gets a
deliberate white lie — `200 {"ok":true,"message":"ثبت شد."}` — and **no order is
written**. That is correct for a bot and catastrophic for a buyer: phone browsers
and password managers autofill a form's "company" from the user's own details, so a
real customer's submission looks automated and is silently dropped.

A visible checkout form must not have that field at all (the platform still
rate-limits and honeypots direct posters). And a `200` with **no receipt URL** is
not a success: keep the form open and show a failure, because that is exactly what
a honeypot drop returns. On 2026-11-22 this cost a café a table order whose buyer
was told «ثبت شد.» — the CMS now logs the drop as a warning.

---

## 4. Dine-in, table QRs and the token

Biza Miz prints a QR per table. The link is

```
https://<site domain>/menu?tableToken=<token>       // TABLE_QR_MENU_PATH, default /menu
```

with `?t=` still accepted for older links. The token matches
`^[A-Za-z0-9._~:/+-]{8,512}$`.

What a theme must do:

1. **Serve the menu at `/menu`.** The POS's default path is `/menu`, not `/`. A
   theme that only serves the poster at `/` 404s every scan — which is exactly
   what happened on `cafe1` until it was fixed. Keep `/` as well; alias one to the
   other, and let a real page with slug `menu` win if the site defines one.
2. **Forward the token verbatim** and only let it decide whether dine-in is
   *selectable*. The theme never validates it and never answers "is this token
   valid?" — that answer would let anyone probe another tenant's tables.
3. **Send it back only for `dine_in`.** Takeaway must not carry it.
4. **Never render it.** Not in the receipt, not in an error, not in a log line
   that ships to a browser.

A forged token is refused by Biza on intake, not by you. That is deliberate.

---

## 5. The receipt

`ESHOBE_RECEIPT_SECRET` — the site's copy of the CMS `PAYLOAD_SECRET` — is what
signs `…/checkout/<orderId>?r=<sig>`. Without it the theme can answer checkout but
cannot show the buyer a receipt; refuse loudly rather than half-working.

- Verify the signature **before** the credentialed order read.
- `cache-control: no-store`, `referrer-policy: no-referrer`, `noindex`.
- Render **both axes**. A café order has a payment status (`pending`, `paid`,
  `refunded`, `cancelled`) *and* a fulfilment (`awaiting_approval`, `accepted`,
  `preparing`, `ready`, `served`, `rejected`, `cancelled`) under `order.cafe`.
  A rejected order is still `pending` on the payment axis — printing
  «در انتظار پرداخت» and its card-transfer instructions invites a payment the
  café has already refused.

Also render the service mode, and the table label when the CMS has one, so the
guest and the staff are reading the same thing.

---

## 6. What you must not break

The theme does not implement these, but a wrong assumption in the theme breaks
them:

- **`order.submitted` fires once** on create, over the signed webhook fan-out and
  on the poll feed (`order:submitted:<orderId>:<createdAt>`). The POS ingests it,
  creates its own order and waits for staff to accept it.
- **`order.paid` is suppressed** for `payment.provider === 'counter'` and for
  status writes that arrived with a site key (the POS telling you what it already
  knows). Do not treat its absence as a failure.
- **The POS writes state back** with `PATCH /api/site/cafe-orders/:orderId/state`
  (`fulfillment`, `counter_payment`, `payment`). So "pending" in your UI may mean
  "pending payment" *and* "accepted by the kitchen" — read `order.cafe`.
- **Stock settlement** happens in the CMS for ordinary orders; a café order
  decrements no CMS product stock, including lines for CMS-owned products, because
  the POS fulfils it end to end.

---

## 7. Rendering checklist

- **Server-render the menu.** Item names, prices and add-on deltas are the
  server's; a client that does arithmetic on them is a preview at best.
- **Group and order** by category `menuOrder` → item `menuOrder` → source id.
- **Sold out** is `menuAvailability`/stock per §2.6 — not `inventory > 0` alone.
- **Required groups** gate the button; optional groups never block.
- **The cart is a draft.** Keep it in memory (a cart that survived a reload on a
  table's shared phone would order somebody else's drink), and let the CMS be the
  only price authority.
- **A cart line is a snapshot.** Name, chosen labels, signed deltas and unit price
  are what the guest agreed to; the receipt shows what the CMS recorded.
- **Version your static files.** `/app.js?v=<content hash>`. Serving an unversioned
  script with `max-age=3600` pairs the new HTML with the old script for an hour
  after every deploy — the new menu markup with the cart-less code was exactly
  that symptom.
- **Every file you serve must be copied by your Dockerfile.** A `server.js` static
  map is not a build step; a file missing from `COPY` 404s only in production,
  where the page still renders and only one feature is quietly absent.
- **Do not cache availability longer than the POS tick** (the CMS drains the sync
  every 60 s). A minute of staleness is fine; a day is a sold-out drink being sold.

---

## 8. Verification before you call it done

On a live site (replace the product ids and token with real ones):

```bash
# 1. The descriptor says store, and offers the block.
curl -s -H "Authorization: Bearer $ESHOBE_API_KEY" https://cms.example/api/site \
  | jq '{type, blocks, currency: .store.currency}'

# 2. The menu is the POS's order, not creation order.
curl -s -H "Authorization: Bearer $ESHOBE_API_KEY" \
  'https://cms.example/api/products?limit=5&depth=1&locale=fa&where[_status][equals]=published' \
  | jq '.docs[] | {title, menuOrder, menuAvailability, menuSourceId, modifiers: (.modifierGroups | length)}'

# 3. Both entry points render, and the token survives the alias.
curl -s -o /dev/null -w '%{http_code}\n' https://shop.example/
curl -s -o /dev/null -w '%{http_code}\n' 'https://shop.example/menu?tableToken=abcdefgh12'

# 4. The visitor write reaches the tenant (this is the Host rule).
curl -s -X POST -H 'content-type: application/json' \
  --data '{"items":[{"product":"<id>","quantity":1}],"name":"x","phone":"09120000000",
           "checkoutRequestId":"verify-0001","serviceMode":"takeaway","paymentChoice":"counter"}' \
  https://shop.example/api/checkout
# 200 with a confirmationUrl = good. 400 {"message":"unknown host"} = §3.1.
```

Then in the browser: a required add-on disables the button until chosen; the cart
total equals unit + deltas × quantity with the site's digits and unit; the receipt
opens, says what actually happened, and shows no token.

---

## 9. Deployment

`eshobe.theme.json` must declare `contractVersion: 1`, `proxiesApi: true`,
`siteTypes` including `store`, `build.healthCheckPath`, and
`deployment.registryImageRepository`. CI builds the image, and
`publish-image.yml` registers the artifact with the CMS — the CMS deploys an
artifact, never a tag of your choosing.

Environment the platform injects:

| Variable | Use |
|---|---|
| `ESHOBE_CMS_URL` | CMS origin for server calls (internal origin in a deployed theme) |
| `ESHOBE_API_KEY` | **server-only** site key; never in HTML or client JS |
| `ESHOBE_SITE_ID` | the site's id; `/api/site` must return the same one |
| `ESHOBE_SITE_DOMAIN` | the primary domain (branding, canonical origin) |
| `ESHOBE_SITE_TYPE` | `store` \| `business` \| `portfolio` — the menu is a store surface |
| `ESHOBE_PUBLIC_ORIGIN` | public origin for canonical URLs and sitemaps |
| `ESHOBE_DEFAULT_LOCALE`, `ESHOBE_LOCALES` | the site's languages |
| `ESHOBE_CURRENCY` | the selling unit (`IRT` default) |
| `ESHOBE_CONTRACT_VERSION` | `1` |
| `ESHOBE_REVALIDATE_SECRET` | verify `POST /api/revalidate` |
| `ESHOBE_RECEIPT_SECRET` | receipt signature — equals the CMS `PAYLOAD_SECRET`; set it in the site's «تنظیمات پوسته», not in the repo |

For the café, the block needs `mode: 'cafe'` and a `limit` at least the size of
the menu; the site needs `type: 'store'`; and the home binding needs to point at a
page that actually contains the block.

---

## 10. Where each rule lives

When behaviour and this document disagree, these files decide — in that order for
the first two:

| Rule | File |
|---|---|
| Availability, sort order, `999` sentinel, modifier bounds (the reference) | `src/lib/cafe-menu.ts` |
| Checkout validation, server-side pricing, idempotency, counter payment | `src/endpoints/checkout.ts` |
| Product fields: `menuAvailability`, `menuOrder`, `externalInventory`, `modifierGroups` | `src/collections/Products.ts` |
| `maxSelections` range (`MAX_MENU_SELECTIONS`) and option cap | `src/lib/cafe-menu.ts`, enforced again in `src/collections/hooks/validateProductCommerce.ts` |
| The POS sync endpoints (`PUT /api/site/cafe-menu/…`) | `src/endpoints/cafeMenuSync.ts` |
| POS state writes (`PATCH /api/site/cafe-orders/:id/state`) | `src/endpoints/cafeOrderState.ts` |
| The block's `mode`, `limit` (≤100), `populateBy` | `src/blocks/ProductGrid/config.ts` |
| `productGrid` is store-only | `src/blocks/index.ts` (`siteTypes` table) |
| Platform reference renderer for a café menu | `src/blocks/ProductGrid/CafeMenu.tsx`, `CafeMenuClient.tsx` |
| The event and poll-feed shapes a POS consumes | `docs/cafe-menu.md` §Events |

---

## 11. Troubleshooting, from real incidents

| Symptom | Cause | Fix |
|---|---|---|
| POS sync returns `400 «داده‌های منو معتبر نیستند»` for every item with add-ons | a group sent `maxSelections: 999`, the CMS capped it at 100 | CMS accepts 999 (`MAX_MENU_SELECTIONS`); do not re-introduce a lower cap |
| Poster shows 8, or 24, of N items | block `limit` (old max 24) and a theme clamp | raise the block limit (≤100) and the theme's own clamp |
| The menu page renders an empty menu | home is bound to a page with no `productGrid` block, or the site is not `store` | add the block in `cafe` mode; check `site.type` |
| Every table QR 404s | the theme serves `/` only; the POS prints `/menu` | serve the menu at `/menu` too |
| Checkout always `400 unknown host` | the write proxy used `fetch` with a `Host` header | send writes with `node:http` (§3.1) |
| The sheet says «ثبت شد.» and no order exists | the form had a `company` field, a phone autofilled it, and the CMS honeypot answered success without writing | remove the field and treat a `200` without a receipt URL as a failure (§3.2); check the CMS log for `honeypot field was filled` |
| Cart totals print raw numbers | the money helper 404s (missing from the Dockerfile) or was never loaded | ship it, load it before the cart script, unit-test it against `@eshobe/site-runtime` |
| New HTML, old behaviour after a deploy | static assets unversioned and cached for an hour | `?v=<content hash>` |
| Receipt page `503` / "not configured" | `ESHOBE_RECEIPT_SECRET` unset on the site | set it in «تنظیمات پوسته» and redeploy |
| Receipt says «در انتظار پرداخت» for a refused order | only the payment axis was rendered | render `order.cafe.fulfillment` (§5) |
| POS inbox fails with `product_id_required` | the POS read `line.productId`; the CMS sends `items[].product` | POS maps the relationship — the CMS shape is the contract |
| Items appear but in random order | sorted by `-createdAt` | category `menuOrder` → item `menuOrder` |
| A sold-out drink is still buyable | availability read only from `inventory` | use `menuAvailability` per §2.6 |
| Dine-in is offered on a forged link | the theme decided token validity | never validate; forward it and let Biza refuse |
