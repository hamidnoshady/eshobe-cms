# Wave 7 — the store

Issue #8. The plan said: spike `@payloadcms/plugin-ecommerce` before committing to
it, and fall back to "a `products` collection plus checkout" if its collections
resist tenant scoping.

**The spike ran. The fallback is what shipped.** Not because the plugin fights
multi-tenancy — it mostly does not — but because the parts it *does* provide are the
parts this platform cannot use, and the parts it would need are the parts we would
have to write ourselves and then defend inside somebody else's beta code.

Everything below is measured, not reasoned: each finding is a test that ran against a
live Postgres with both plugins loaded (harness in *Reproducing the spike*, bottom of
this file). Plan §6 (Waves) and §7 (Risks) are the framing.

---

## 1. What the spike was for

Three questions, all unanswered by the docs — the plugin ships a README that reads
"A set of utilities… more to come", and its interaction with `plugin-multi-tenant` is
documented nowhere.

| # | Question | Answer |
|---|---|---|
| 1 | Do its collections tenant-scope? | **Back office yes, storefront no.** See §2. |
| 2 | Do its access rules and `customers` fight tenant scoping? | **Yes — the customer model is the blocker.** See §3. |
| 3 | Full plugin, piece-meal, or fallback? | **Fallback.** See §4. |

Timebox: one day. Roughly half of it was reading `dist/`, half running the config.

## 2. Tenant scoping: works, and does not work, in the same place

The plugin appends its collections to `incomingConfig.collections`, and
`plugin-multi-tenant` runs after it, so registering `products`, `variants`, `carts`,
`orders`, `addresses` and `transactions` in the plugin's `collections` map is
mechanically clean: **every one of them took the `site` field, the config booted with
no error and no `missing collections` warning.**

Admin-side isolation then holds, for the reason `CLAUDE.md` already states:

- a site's owner listed **only their own** products, and reading another site's
  product by id returned nothing;
- a cross-tenant **cart line was refused at write time** — `plugin-multi-tenant`
  rewrites every relationship field's `filterOptions` with the *document's* own
  tenant, and Payload validates relationship values against `filterOptions` on save
  (`ValidationError: Items 1 > Product`). That was a pleasant surprise: the cart
  cannot be filled with another site's products, not even with `overrideAccess: true`.

And it fails in the two places a storefront lives:

- **An anonymous read is unscoped.** `withTenantAccess` ANDs the tenant constraint
  only `if (args.req.user && args.req.user.collection === adminUsersSlug …)`. A public
  visitor has no user, so `GET /api/products` returns **every customer's published
  products in one list** — measured: 2 docs across 2 sites. Nothing about the plugin
  makes that better or worse than the other plugins; it is the standing rule of this
  platform (`findForSite` is the answer), but it means the plugin's own front-end
  provider (`useCart`, `EcommerceProvider`, which talks to `/api/...` directly)
  **cannot be used as shipped on a multi-tenant deployment.** That is the finding that
  should decide the matter on its own: the plugin's React layer is the storefront, and
  the storefront is exactly where scoping is absent.
- **`site` is accepted from the request body.** A guest cart created with
  `site: <any site id>` succeeded. This is the form-submissions hole from Wave 3
  (`src/plugins/index.ts`), with money at the end of it: whoever pays for a
  `pending` order is whoever the *client* said. Anything built on this plugin needs
  the same `beforeValidate` override we already wrote for forms — inside the
  plugin's collections, on a beta release.

## 3. `customers` is the wall

`customers.slug` defaults to `'users'`. On this platform `users` is the staff
collection, and `plugin-multi-tenant` treats "member of no tenant" as *no access to
any tenant-scoped collection at all*. Measured, in order:

1. A `users` account with no site assignment reading **its own cart**:
   `Forbidden: You are not allowed to perform this action.` Not empty — forbidden. A
   storefront customer cannot exist.
2. The fix the plugin implies — put the customer in a tenant — turns the customer
   into a site member, which grants read on **every tenant-scoped collection of that
   site, drafts included** (measured: the account then listed a draft page of the
   site's). Tenant membership is not a "shopper" role; there is no narrower version
   of it in the plugin.
3. The way out is a **separate `customers` auth collection** (the plugin supports
   `customers: { slug: 'customers' }`). Then shopping works — a customer can create
   and read their own cart, and cannot read a stranger's. But the tenant wrapper only
   fires for the *admin users* collection, so a customer session lists
   **products across every site**, and every storefront query needs a hand-written
   tenant predicate. Which is the same amount of work as owning the collection, with
   none of the control.

## 4. What else the plugin would have cost

Individually small, collectively the decision.

- **`products` has no content model.** Its fields, verbatim: `site, inventory,
  enableVariants, variantTypes, variants, priceInIRTEnabled, priceInIRT, …, _status`.
  No title, no slug, no description, no image, nothing localized (`localized fields
  across all ecommerce collections: []`). A Persian-first store's product *is* its
  title and its copy, so the catalogue is `productsCollectionOverride` — i.e. the
  collection we were going to write anyway, wrapped in someone else's schema.
- **Currencies are one platform-global config.** `currencies.supportedCurrencies`
  builds one `priceIn<CODE>` column set on every product of every site. "Per-site
  currency configuration" (an issue checkbox) is then expressible only as "every site
  carries every currency's columns and hides the wrong ones", with a shared column
  set across tenants. We need the opposite: one unit per *site*, decided once.
- **`addresses.create` is `isAuthenticated`** — every account on the platform, with
  `site` chosen by the caller.
- **The plugin overwrites its own i18n namespace.** It merges `plugin-ecommerce`
  translations over anything in `payload.config.i18n` — the same trap
  `plugin-multi-tenant` already documents in this repo's notes. (It does ship a full
  `fa` dictionary, which is more than most plugins here get.)
- **The README is one sentence.** For a beta dependency the issue itself calls
  "breaking changes expected", the only documentation is `dist/`.
- Amounts are stored in the currency's *smallest* unit and `Intl` renders the admin
  cell. For a currency with no subunit that is fine; for the Toman/Rial question below
  it means the 10× step lives in the same file as a moving target.

## 5. Stripe is not the payment story here

The issue's "done when" is *"a real Stripe payment"* and its checklist has
`pnpm add stripe`. That was written before the platform's own constraint was put
beside it:

- **Iran is not a Stripe-supported country** for opening a merchant account — it is
  on the blocked list, and the workaround every guide offers is "register a company
  in the US or the UK".
- **`IRR` is not a Stripe presentment currency**, and neither is a Toman code.

For a Persian-first platform hosting Iranian businesses, "the store is done when it
takes a Stripe payment" would be a checkbox almost no customer can tick. So:

- The payment path is behind a **provider seam** (`src/payments/types.ts`) shaped like
  the plugin's own `PaymentAdapter` — `initiate` / `confirm` / optional endpoints — so
  if the plugin is ever adopted for its catalogue, adapters move across unchanged.
- Two providers ship: **`bank`** (کارت به کارت: instructions on the receipt page, a
  human confirms, stock settles on the status change — no third party at all, and the
  reality for a large share of small Iranian stores) and **`http`** (a generic
  JSON create/verify gateway contract that a ~20-line ZarinPal/IDPay/Saman bridge
  implements; exercised end to end in the test suite against a local mock PSP).
- **Stripe comes back as a third adapter** the day a customer with a foreign entity
  wants to take USD. It is ~60 lines against this seam and needs no schema change.

## 6. Toman or Rial — decided

The official currency is the Rial; every price a human quotes is in Toman, and the
two differ by 10×. Getting it wrong is not a visible bug: `۱۲۰٬۰۰۰` looks like a
price either way.

`src/lib/money.ts` decides it once, for the platform:

- **Prices are stored as an integer count of the site's currency's minor unit.** Never
  a float, never a Rial amount, never the display string.
- **The unit belongs to the site** (`store.currency`, default `IRT` — Toman), not to
  the product. One store, one unit; there is no per-product currency to disagree with.
- Render and input are one module and inverse by construction: `formatPrice()` in
  `src/lib/format.ts` (so prices get Persian-Indic digits and the Shamsi-first
  platform formatter like every other number — §3.6 of the plan) and `parsePrice()`
  which accepts `۱٬۲۰۰٬۰۰۰`, `1,200,000`, `۱۲۰۰۰۰۰ تومان` and rejects a fractional
  Toman instead of rounding it.
- `tomanToRial` / `rialToToman` exist so the 10× step appears **once**;
  `rialToToman` throws on a figure that is not a whole Toman, because that number can
  only exist if someone already made the mistake.
- Orders snapshot `currency` and `unitPrice` on themselves: a site that switches units
  later must not rewrite what somebody paid.

`IRR` is selectable if a customer insists. Nothing in the platform converts for them.

## 7. What shipped instead

No cart, per PLAN decision #5 ("catalog + Stripe Checkout first, cart later"), and the
issue's own fallback line ("catalog-and-buy-button covers most small stores and needs
no cart at all").

| Piece | File | Notes |
|---|---|---|
| Products | `src/collections/Products.ts` | Drafts + the platform's publish gate, localized title/summary, optional image, integer minor-unit price, optional stock count. |
| Orders | `src/collections/Orders.ts` | One line, one buyer, `pending → paid`, prices and currency snapshotted, staff-only read. |
| Store settings | `src/collections/Store.ts` | Per-site singleton (`isGlobal: true`): currency, provider, payment instructions (field-locked to staff). |
| Checkout | `src/endpoints/checkout.ts` | `POST /api/checkout`, plus the gateway's callback and the browser's return on `/api/checkout/callback`. |
| Providers | `src/payments/` | `bank`, `http`, and the seam. |
| Receipt | `src/lib/order-receipt.ts` | HMAC over `order + site`, so a buyer can see their own order and nobody else's. |
| Catalogue block | `src/blocks/ProductGrid/` | `store` sites only, buy button on the card, prices rendered through the platform formatter. |
| Money | `src/lib/money.ts` | §6. |

All three collections are registered in the multi-tenant plugin's `collections` map,
and `tests/int/store.int.spec.ts` now fails the build if a collection ever appears
without a tenant field — the rule in `CLAUDE.md` that used to be a sentence is a test.

### Explicitly not in this wave

Shipping, tax and subscriptions (never in the plugin either way), discounts/coupons,
variants (a product is one price; a store that needs sizes needs the cart conversation
again), product categories and product *pages* (the catalogue block is the product
surface; a `products/[slug]` route needs a revalidation story of its own), email
receipts (no email adapter is configured platform-wide), and any payment *settlement*
report — an owner reconciles against the PSP's own panel using `payment.reference`.

## 8. Review notes for the people after us

- **`settleStock` moves stock at `paid`, not at `create`.** The consequence is stated
  in the file: two buyers can both reach a checkout for the last unit, and the second
  is refunded rather than oversold silently. Reserving at order time needs a TTL job
  this platform has nowhere to run yet (the jobs queue runs in the single web
  container).
- **`orders.create` is staff-only and the endpoint writes with `overrideAccess: true`.**
  The alternative — public create on an orders collection whose `site` field the
  client can fill — is the hole Wave 3 closed for form submissions. The endpoint
  resolves the tenant from `Host`, prices from the product row, and refuses a draft or
  foreign product with the *same* answer, so it is not a probe.
- **No rate limiting on checkout.** A buyer with a script can create unlimited
  `pending` orders; the honeypot stops lazy bots and nothing else. Before a store site
  is public, this is the line item.
- **Rotating `PAYLOAD_SECRET` invalidates every receipt link in every inbox** —
  they are signed with it. Noted in `.env.example`.
- **`/api/checkout*` is a Caddy carve-out on customer domains** (`Caddyfile`, Wave 4).
  Without it the storefront 404s on every real domain and works only in dev — the
  classic shape of a bug that ships.
- The generated **down migration is hand-patched** (see the comment in
  `src/migrations/20260827_*_wave7_store.ts`): `DROP TABLE … CASCADE` already removes
  the `*_rels` constraints the generated `DROP CONSTRAINT` lines then fail to find.
  `up`/`down`/`up` was run against Postgres to prove both directions.

## 9. Reproducing the spike

The harness is deliberately not committed: it depends on the beta plugin, and a test
that installs a dependency we rejected would invite someone to reconsider. To run it
again:

```bash
pnpm add @payloadcms/plugin-ecommerce@3.88.0     # matches payload 3.88.0 in this repo
```

then a `tests/int/*.int.spec.ts` that builds a config with, in this order —
**ecommerce first, multi-tenant last** (the plugin only sees collections that exist
when it runs):

```ts
plugins: [
  ecommercePlugin({
    access: {
      adminOnlyFieldAccess, adminOrPublishedStatus, isCustomer, isDocumentOwner, isAdmin,
    },
    carts: { allowGuestCarts: true },
    currencies: { defaultCurrency: 'IRT', supportedCurrencies: [IRT, IRR] },
    customers: { slug: 'users' },          // and again with 'customers'
    products: true, orders: true, addresses: true, transactions: true,
  }),
  multiTenantPlugin({
    collections: { products: {}, variants: {}, carts: {}, orders: {}, addresses: {}, transactions: {} },
    tenantField: { name: 'site' },
    tenantsSlug: 'sites',
    userHasAccessToAllTenants: isPlatformAdmin,
  }),
]
```

against a throwaway database (`postgresAdapter({ idType: 'uuid', push: true })`), with
two `sites`, one owner per site, one unassigned `users` account, and one content
collection with drafts so "what does tenant membership grant?" is measurable. The
answers in §2–§3 are what that config printed; §4 is `dist/collections/*` and
`dist/utilities/*`, which is where the rest of it had to come from.
