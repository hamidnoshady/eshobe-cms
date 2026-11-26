# WordPress + WooCommerce → Eshobe CMS — Migration Matrix

The capability map behind issue #166 and the Migration Center in
**Settings → Migration Center** (`/admin/migration-center`). This matrix is
deliberately narrower than a marketing claim: **Implemented** means the
destination, importer, ledger disposition and reconciliation path exist in
this repository. It does **not** mean a particular site can cut over without
its own dry-run, coverage review and write-fenced reconciliation.

The engine is exercised end-to-end with a fixture-backed fake WordPress and
WooCommerce connector in `tests/int/migration-engine.int.spec.ts`. Those tests
prove idempotency and failure behaviour against the REST contract; they are
not a substitute for a dry-run against the customer's real source.

## Status legend

- **Implemented** — imported natively and recorded in the migration ledger.
- **Requires mapping** — representable, but a person must confirm money,
  locale, field/SEO mapping or another site-specific decision. The coverage
  report says so before an import runs.
- **Archive/manual** — the source payload (or readable HTML) is preserved
  with provenance, but functional parity needs an adapter or human rebuild.
- **Blocking** — importing around it could lose data or state; the job ends
  `blocked`, the record is visible in `migration-records` /
  `migration-errors`, and cutover is refused.
- **Not imported** — outside this importer. It must be handled separately
  before the WordPress site is decommissioned.

## How the Migration Center runs

1. An owner/platform administrator registers the WordPress HTTPS URL and
   read-only credentials. Host resolution rejects private, loopback and
   metadata addresses (SSRF guard); credentials are encrypted at rest and
   only a redacted summary is returned to the browser.
2. **Discover** reads WordPress post types/taxonomies and, when credentials
   exist, WooCommerce settings/products. An empty REST inventory is treated
   as potentially incomplete, not as an empty site: types hidden with
   `show_in_rest=false` produce a blocking warning because this connector has
   no database/agent fallback yet.
3. **Dry-run** writes no destination documents. It creates/updates ledger
   rows in `migration-records` with disposition `planned`, plus coverage,
   blockers, would-create/would-update/unchanged counts and redirect
   expectations.
4. **Import** and **Sync** run in dependency order: definitions → terms and
   categories (parents linked after their pages arrive) → media → posts,
   pages and CPT entries → products → customers → coupons → orders/refunds →
   current stock → explicitly declared ACF relationships → menus → comments
   and product reviews → redirect inventory/application. WooCommerce may remain
   the single writer and imports may be repeated; the idempotency key is
   `site + source installation + resource + source record id`.
5. **Reconcile** rescans the selected source resources and compares source
   hashes, ledger rows, destinations, open errors, redirect problems,
   order/refund totals and WooCommerce product-review ratings read again
   from Woo's own reviews endpoint.
6. **Cutover** requires an explicit confirmation that WordPress is
   write-fenced. It performs a final sync, force-applies non-conflicting
   redirects, reconciles again and only then marks the job `completed`.
   It does **not** change DNS; moving DNS remains the operator's step after
   the CMS reports a clean cutover.
7. **Rollback** (automatic, pre-cutover only) deletes redirect rows and
   destination documents that the ledger proves this migration created and
   that have not changed since import. A document edited in Eshobe becomes a
   visible rollback conflict and is never deleted. Content-type definitions
   are the deliberate mapping exception: every import snapshots the field
   schema it used into the definition's ledger metadata, so if rollback
   deletes that migration-created definition after an operator declared ACF
   relationships and re-imported, the next import restores those explicit
   field decisions instead of re-inferring them away. After cutover, rollback
   is an operational DNS/data decision, because Eshobe may already have new
   orders and edits.
8. **People & accounts** stay explicit. The owner can load WordPress
   staff-role users, choose an Eshobe tenant role per person and send the
   normal set-password invitation; only a WP administrator may become site
   owner. Imported Woo customers remain `customers`, can receive one-time
   expiring claim emails from the center, and a storefront theme exchanges
   the token once for the verified customer identity. No WP password/hash or
   shopper-to-CMS-user promotion occurs in either path.

The HTTP control surface is session-authenticated and tenant-checked:
`GET /api/site/migration`, `POST /api/site/migration/source`,
`POST /api/site/migration/job`, job settings/queue/control/write-fence POSTs,
`POST /api/site/migration/customer-claims/invite`,
`GET /api/site/migration/staff-candidates` and
`POST /api/site/migration/staff/invite`. Editors may read their own site's
center; only site owners and platform administrators may change it. Site API
keys cannot run migrations or issue invitations. The separate storefront
claim exchange is `POST /api/site/customer-claims/exchange`, tenant-resolved
from a site key or customer `Host`, rate-limited and token-consuming. Jobs
are queued and drained by the scheduled `migrationJobs` Payload task, with
checkpoints, a per-job lock, pause/resume/cancel control, batches, events,
errors and audit rows.

## Content

| WordPress | Eshobe destination | Status | Notes |
|---|---|---|---|
| `post` | `posts` | **Implemented; mapping review** | WordPress statuses map through `src/lib/entry-status.ts`; categories land in `categories`, other attached vocabularies in `posts.taxonomyTerms`. Body goes through the Gutenberg/HTML converter. Featured/OG media, published date and known Yoast/RankMath fields are mapped. |
| `page` | `pages` | **Implemented; mapping review** | Real `parent` relationships are imported and validated as same-site/acyclic with `validatePageParent`. The converted body becomes a full-width content block. Because native public lookup uses the stored leaf slug, a moved nested permalink is placed in the redirect inventory rather than silently changing meaning. |
| Custom post types | `content-type-definitions` + `content-entries` | **Implemented** | Never flattened into `posts`. The importer creates one definition per CPT, preserves archive slug where valid, hierarchical parents, status, menu order, dates, featured image/gallery, SEO and provenance. A REST-invisible or operational CPT can be classified blocking. |
| `category` | `categories` | **Implemented** | Parent chains are linked and guarded by `validateCategoryParent`. |
| Custom taxonomies, `post_tag`, `product_cat`, `product_tag` | `taxonomy-definitions` + `taxonomy-terms` | **Implemented** | Vocabularies stay separate; flat taxonomies remain flat and hierarchical taxonomies keep parents. CPT assignments become `entry-term-relations`; posts and products also receive direct term relationships used by their existing surfaces. |
| ACF/public post meta | definition `fieldSchema` → entry `fieldValues` / `unmappedMeta` | **Implemented; mapping review** | The engine infers primitive field types from sampled `acf` and public `meta`, writes proposed `migration-mappings`, resolves media/gallery values when the destination schema names those types, and keeps unmapped/ambiguous values visible. It does not fetch a separate ACF field-group definition endpoint. |
| ACF relationship/post-object values | entry `fieldValues` + `content-relations` when the schema declares the target; otherwise `unmappedMeta` | **Implemented; explicit mapping required** | A bare source ID still does not name its destination collection, so the importer never guesses. When an operator changes the field schema to `relationship` with an explicit `relationTo`, the post-commerce pass resolves every source ID, writes destination IDs to `fieldValues`, creates/retires deterministic `acf:<field>` edges and removes the key from `unmappedMeta`. Missing targets leave the whole value unmapped with an open migration error. |
| Gutenberg/HTML | Lexical body/content | **Implemented** | Supported core vocabulary includes paragraph, heading (clamped to h1–h4), list, quote/code, separator, table text, group/columns, image/gallery captions, links and inline formatting. Unknown blocks contribute readable text and named conversion warnings. Scripts, iframes, forms and unsafe link protocols are never executed or embedded. |
| Elementor/other page builders and shortcodes | readable Lexical text + provenance; CPTs may also store `preservedHtml` | **Archive/manual** | WordPress plugins do not run in Eshobe. A 1:1 builder rebuild remains a theme/manual task. Coverage marks recognized builders archive-only. |
| Attachments | `media` | **Implemented for platform-supported images** | AVIF, GIF, JPEG, PNG, SVG and WebP are downloaded over the guarded HTTPS path and imported before content/products. Unsupported media types are visibly blocked rather than replaced with a broken remote URL. |
| Menus (`nav_menu`, menu items and locations) | `menus` | **Implemented; theme location mapping review** | The importer reads `/wp-json/wp/v2/menus` and `/menu-items`, preserving menu slug/name/description, all locations, item order, parent keys/depth, status, CSS classes, new-tab flag and source object metadata. Page/post/product/CPT/category/taxonomy/media targets become same-site references; custom and archive items become rewritten internal paths or safe external URLs. Header/Footer are not overwritten: the destination theme chooses which menu location to render. An old source without the menus REST routes is visibly blocked. |
| Comments and WooCommerce product reviews | `comments` | **Implemented; moderation/PII review** | The importer reads WP comment types `comment` and `review` in edit context with `status=any` (WP's `all` would omit spam/trash), preserving body, submitted time, threaded parent, moderation status (`approved`/`pending`/`spam`/`trash`) and exactly one post/page/product/CPT target. Core does not expose WooCommerce's unregistered `rating` comment meta, so product-review ratings (0–5) are stamped from `/wp-json/wc/v3/products/reviews` across every moderation status; if that endpoint is unavailable the rating gap is an open migration error, not a silent zero. Registered customer authors link to imported `customers` when resolvable. Author email is staff-only at field level; anonymous reads expose only approved comments on published targets. Reconciliation independently rescans Woo's review ratings and blocks cutover on any missing/extra/changed rating (`fieldMismatches`). Importing history does not open a public submission endpoint. |
| WordPress staff users/authors | CMS `users` + site tenant role | **Implemented; explicit owner mapping** | Accounts and roles are never created by the importer. On demand, the center reads authenticated WP users with administrator/editor/author/contributor/shop-manager roles; the owner selects people and roles, with WP administrator as the only owner-eligible source role. Existing Eshobe users are assigned without role downgrade, new users get a random unseen password plus Payload's set-password email, and each decision is ledgered/audited with `createdByMigration: false` so rollback cannot delete a person's account. Source author IDs/names also survive in content provenance. |
| Revisions and autosaves | — | **Intentionally excluded** | Editorial history is not published content. Internal WordPress types are labelled in discovery; they are not represented as destination content. |

## Commerce (WooCommerce)

| WooCommerce | Eshobe destination | Status | Notes |
|---|---|---|---|
| Simple product | `products` | **Implemented; money review** | SKU, regular/sale price, status, summary/body, featured image/gallery, dimensions, virtual/downloadable flags, product categories/tags and known SEO fields map natively. Prices use the job's reviewed source currency/decimals and target currency. |
| Variable product, attributes and variations | `products.attributes` + `products.variations` | **Implemented; money review** | Each variation keeps its source ID/key, attribute values, label, SKU, price/compare-at price, image, status and weight. A variable product with no returned variations is blocked instead of imported as a pseudo-simple product. |
| Grouped/external product | `products` | **Implemented; mapping review** | Grouped members, upsells and cross-sells are linked after all products exist; external URL/button text are retained. Product types outside `simple`, `variable`, `grouped` and `external` are blocking. |
| Product stock | `products.inventory` and variation stock | **Implemented** | Products are first imported without applying live stock. Historical orders then run under the migration context, and current stock is applied once per import/sync afterwards in `applyCurrentStock`. |
| Customers | `customers` (separate from CMS `users`) | **Implemented; invite/claim exchange** | Profile, username, billing/shipping addresses and order links import. `claimStatus` starts `unclaimed`; password hashes are never copied and later Woo delta sync preserves invited/claimed state (revoking an outstanding token only if the source email changed). Owners send single or bounded-bulk one-time claim emails from the center; only the token hash and expiry are stored. The theme exchanges the token once at `POST /api/site/customer-claims/exchange` and binds the returned verified customer ID/email/name to its own storefront account/session. |
| Coupons | `coupons` | **Implemented; money review** | Percent/fixed cart/fixed product amount, min/max, usage limits/count, product inclusions/exclusions, individual-use/free-shipping flags and validity window map. Historical orders retain coupon lines/discounts. |
| Orders | `orders` + `orders.items` | **Implemented; exact-money gate** | All lines remain lines: product snapshot, variation key/label, SKU, quantity, unit price, line subtotal/tax/total. Order subtotal, discount, shipping lines/total, tax lines/total, fees, coupons, addresses, customer note, payment fields and a payment-history row from the available method/transaction/paid-at fields are retained. The legacy `product`, `quantity`, and `unitPrice` fields mirror only the first line for backward compatibility. |
| Refunds | `orders.refunds` | **Implemented** | Refund rows are fetched per order and participate in reconciliation totals. |
| Order statuses | `pending`, `paid`, `cancelled`, `refunded` | **Implemented; some folds are lossy** | `processing`/`completed` fold to `paid`, `on-hold` to `pending`, and failed/trash-like states to `cancelled`; the original status is retained in provenance and ledger metadata flags the lossy fold. |
| Historical replay | migration context | **Implemented** | Importer writes carry the site-bound context from `src/lib/migration-context.ts`, standing down stock settlement, order-paid/reversal events and related side effects. Money is checked as integer minor units before the order is written; a mismatch blocks the order. |
| Subscriptions, memberships, bookings, multi-vendor, LMS, gift cards, deposits, loyalty and bundles | — | **Blocking when detected** | Copying plugin rows would not copy the operational/financial behaviour. Gateway vault/subscription tokens are never transferred. These need dedicated adapters and, for recurring payment, fresh customer/gateway authorization. |
| Payment gateways, cards and vault tokens | — | **Never copied** | Configure the destination site's gateways separately. Historical method/transaction references are metadata, not reusable payment credentials. |
| Download permissions/files beyond product flags | — | **Not imported** | `downloadable`/`virtual` flags survive, but Woo download grants and entitlement delivery need a dedicated digital-goods adapter. |

### Money rule

WooCommerce decimal strings are never copied as floats. The job records
`sourceCurrency`, `sourceDecimals`, `targetCurrency` and, for IRR→IRT, an
explicit `confirmedRialToToman` decision. Conversion is BigInt-exact; order
import requires the converted identity

`subtotal − discount + shipping + tax + fees = total`

in integer minor units. Existing Eshobe checkout behavior stays in the
site's store currency; see `docs/THEME_API.md` §7 for the public contract.

## SEO, redirects and routing

| Source | Eshobe destination | Status | Notes |
|---|---|---|---|
| CPT/taxonomy permalinks | `archiveSlug` + `permalinkTemplate` | **Implemented** | Archive slugs are site-safe and unique per site/locale across definition kinds. The imported CPT template is `/{archive}/{slug}`; unsupported source permalink shapes surface through redirects/review. |
| Yoast/RankMath title, description, canonical, noindex and OG image | destination SEO fields | **Implemented for known keys** | The importer reads the mapped Yoast/RankMath keys listed in `seoOf` (`src/lib/migration/importers.ts`). Other SEO-plugin data remains provenance/manual mapping. |
| WordPress permalink inventory | `migration-redirects` | **Implemented** | For posts, pages, CPT entries, taxonomy terms and products with a source permalink and slug, the engine normalizes old/new paths and records `proposed`, `applied`, `unchanged`, `conflict`, `ignored` or `rolled-back`. Duplicate/self/cyclic rules are detected. |
| Live redirect rule | tenant-scoped `redirects` | **Implemented** | Import may apply rules when `applyRedirects` is selected; cutover force-applies them. An existing editor rule for the same `(site, from)` is a conflict and is never overwritten. The built-in renderer resolves one hop with a permanent **308**; external themes must implement the same collection contract (301 or 308) before their own 404. |
| Sitemap | `/sitemap.xml` | **Implemented by the existing renderer** | Published pages/posts/products and custom entries/type archives are listed according to the site renderer's existing rules; `noindex` entries are excluded. |
| DNS/domain switch | operator/platform domain workflow | **Manual after CMS cutover** | The Migration Center does not claim to move DNS. Do not move traffic until the job is `completed`, redirects are applied, and the destination domain/health checks pass. |

Redirect source paths are unique per **site**, not across the platform:
application validation (`uniqueRedirectFromPerSite`) and the production
`(site_id, "from")` unique index enforce the same boundary.

## Ledger and safety model

The Migration Center adds nine tenant-scoped collections:
`migration-sources`, `migration-jobs`, `migration-batches`,
`migration-mappings`, `migration-records`, `migration-events`,
`migration-errors`, `migration-redirects` and `migration-audits`.

`migration-records` is the source of truth for idempotency. Each row keeps
the source installation/resource/ID, redacted raw payload, source hash,
source permalink/slug/status/modified time, destination collection/ID,
destination update time, disposition, attempts and whether the migration
created the destination. A record is considered unchanged only when both
the source hash and the destination update time still match the ledger; a
manual destination edit therefore invalidates the shortcut and is visible
to re-import/rollback logic. Checkpoint pages are skipped only for an
unfinished paused/crashed run (the run with no `finishedAt`); queueing the
same operation after a completed run starts a fresh scan, so later operator
mapping decisions are actually applied.

Raw payloads pass through secret-shaped key redaction before storage, the
center's API returns sanitized views only, and importer code picks explicit
fields for PII-bearing destinations. Credentials are encrypted and gated to
the migration execution context.

## Hard gates

1. Every fetched selected source record ends imported/updated/unchanged,
   archived with provenance, or visibly blocked/error. There is no silent
   success path for a record the converter could not represent.
2. Orders reconcile exactly by line, totals, shipping, tax, fees and
   refunds in integer minor units.
3. Re-running import/sync creates no duplicate destination for the same
   `(site, installation, resource, sourceRecordId)` ledger key.
4. Source, job, ledger and destination reads/writes are tenant-scoped;
   cross-site parents, terms, customers, coupons, products and redirects
   are refused.
5. Credentials and secret-shaped raw fields are not returned by the
   Migration Center API or written to logs/events.
6. Cutover requires the write fence, a clean final sync, no open blocking
   errors, no redirect conflict and a clean reconciliation.
7. Rollback deletes only migration-created destinations proven unchanged
   since import; human edits are preserved as conflicts.

## Still outside this implementation

- A read-only WordPress agent or database-export connector for data that is
  not exposed through WP/Woo REST. Today, discovery can block such a source;
  it cannot magically read it.
- Automatic staff-account provisioning, automatic customer-claim email
  sending, and a shopper session/account system inside the CMS. Staff
  invitation and customer claim issuance are explicit owner actions; after
  the one-time claim exchange, the storefront theme owns its shopper
  account/session. Imports never turn a WordPress role or password into an
  Eshobe login by implication.
- Functional adapters for page builders, forms, subscriptions and other
  operational plugins listed as archive-only or blocking in coverage.
- Inference of an ACF relationship's destination collection from field names
  or bare numeric IDs. Declaring `relationTo` is supported; guessing is not.
- DNS automation and a post-cutover merge/rollback for writes that occurred
  independently on both WordPress and Eshobe. The supported model is one
  writer at a time: WordPress before the fence, Eshobe after cutover.
- Live-site rehearsal in this repository's automated environment. The
  supported production procedure remains discover → dry-run → import on a
  staging/test tenant or staging window → reconcile → write fence → cutover.
