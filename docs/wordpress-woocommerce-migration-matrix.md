# WordPress + WooCommerce → Eshobe CMS — Migration Matrix

The honest capability map behind issue #166. Every WordPress/WooCommerce
entity names its Eshobe destination and where it stands. **"Supported" means
the destination exists and is tenant-safe today; it does not mean a live
one-click importer runs yet.** Nothing on this page promises zero data loss:
that promise is only ever made per-site, after write-fenced reconciliation
(see *Hard gates*).

## Status legend

- **Ready** — destination schema + rules ship in this PR (or already existed).
- **Next PRs** — designed, not yet implemented. The migration must not claim
  support for these; the wizard will report them as *blocked*, never silently
  skip them.
- **Manual** — no faithful automatic translation exists; the source is
  preserved (raw payload / excerpt) and flagged for human review.

## Content

| WordPress | Eshobe destination | Status | Notes |
|---|---|---|---|
| `post` (blog) | `posts` | Ready (destination existed) | Status mapping: `publish→published`, `draft→draft`, `pending→pending`, `private→private`, `future→scheduled`, `trash→trash` (`src/lib/entry-status.ts`). |
| `page` | `pages` | Ready (destination existed) | Builder-heavy pages keep raw HTML (`preservedHtml` pattern) — rendered as inert text, never executed. |
| **Custom post types** (`book`, `portfolio`, …) | `content-type-definitions` + `content-entries` | **Ready — this PR** | Never flattened into `posts`. Each CPT is one definition row (`key`, localized labels, `archiveSlug`, `permalinkTemplate`, typed `fieldSchema`); entries carry WordPress-shaped `status`, `parent`, `menu_order`, author, featured image, gallery. |
| **Custom taxonomies & tags** | `taxonomy-definitions` + `taxonomy-terms` | **Ready — this PR** | Never merged into `categories` (the blog vocabulary). Hierarchical and flat, parent chains acyclic. `category`/`post_tag` map to the blog's `categories` and a site taxonomy respectively. |
| Term assignment (`term_relationships`) | `entry-term-relations` | **Ready — this PR** | Explicit edge {entry, term, taxonomy, order}; taxonomy derived from the term, must be declared on the entry's type; unique per pair. |
| ACF field groups / post meta | `fieldSchema` → `fieldValues` (typed JSON) | **Ready — this PR** | 14 field types incl. group/repeater/media/relationship. Strict validation (`src/lib/custom-fields.ts`): wrong-typed values are rejected, unknown keys land in `unmappedMeta` — never discarded, never coerced. |
| ACF relationship / post-object fields | `content-relations` | **Ready — this PR** | Typed edges to entries/products/posts/pages/media; `relationKind` keeps the source field name (`acf:related_projects`). |
| Gutenberg blocks | Lexical `body` | Next PRs | Block-by-block converter; unknown blocks degrade to preserved HTML. |
| Elementor / shortcodes / page builders | `preservedHtml` + review queue | Manual | Plugins do not execute in Eshobe. Adapters for common widgets come later; raw output is archived verbatim. |
| Attachments (media) | `media` | Ready (destination existed) | Import order guarantees media lands before entries reference it. |
| Menus | `header`/`footer` nav items | Next PRs | Menu items resolve to imported documents by source mapping. |
| Comments | — | Next PRs | Archive with provenance; no comment engine in v1. |
| Users (authors) | `users` (staff) | Next PRs | WordPress password hashes are **never** imported. Accounts are claimed by email/reset. |
| Revisions, autosaves | — | Skipped by design | Editorial history is not published content; counted in the coverage report as *intentionally excluded*, not dropped. |

## Commerce (WooCommerce)

| WooCommerce | Eshobe destination | Status | Notes |
|---|---|---|---|
| Simple product | `products` | Ready (destination existed) | Price conversion is explicit, never blind: Woo decimals → Eshobe integer minor units; IRR stores need a confirmed ×1/×10 rule (`src/lib/wordpress/mapping.ts`, `decimalStringToMinor`). |
| Variable product / variations / attributes | — | **Next PRs (blocker)** | Destination schema lands *before* any real order import, per the issue. Dry-run reports variable products as blocking today. |
| Product categories/tags | `taxonomy-definitions` (`product_cat`, …) | **Ready — this PR** | Term engine is shared with content; product↔term wiring follows the commerce schema PR. |
| Orders (multi-line) | `orders` (single-product today) | **Next PRs (blocker)** | A Woo order is never flattened to one product. Multi-line items, totals, tax, shipping, coupons, refunds and payment history get their schema first. |
| Customers | — | **Next PRs (blocker)** | Dedicated `customers` (separate from staff `users`) + addresses. |
| Coupons | — | Next PRs | With order history referencing them. |
| Payment gateways / card tokens | — | Never | Credentials and vault tokens are never copied. Gateways are reconfigured per site. |
| Historical order replay | `orders` under migration context | **Ready — this PR (the guard)** | `src/lib/migration-context.ts`: importer writes stamped with a site-bound context make `settleStock`, `emitOrderPaid`, `emitOrderReversal` stand down. Current stock is imported once, *after* history. A context stamped for another site suppresses nothing. |

## SEO & cutover

| WordPress | Eshobe destination | Status | Notes |
|---|---|---|---|
| Permalinks (CPT/taxonomy rewrites) | `archiveSlug` + `permalinkTemplate` | **Ready — this PR** | `/{archive}/{slug}`, `/{archive}/{id}`, `/{slug}`, `/{id}` resolved at request time (`src/lib/content-paths.ts`); archive slugs unique per site+locale across both definition kinds, reserved segments refused. |
| Yoast/RankMath title, description, canonical, noindex, OG image | `metaTitle`, `metaDescription`, `canonicalUrl`, `noindex`, `ogImage` | **Ready — this PR** | Entry metadata + sitemap (published entries & type archives, per-locale, `noindex` excluded). Term archives resolve; sitemap listing follows with term counts. |
| 301/308 redirects | `redirects` (+ migration URL inventory) | Next PRs | Per-site resolver exists; the migration redirect *engine* (inventory → verified map) is its own PR. |
| Sitemap | `/sitemap.xml` | **Ready — this PR** | Pages (existing) + published entries + type archives. |
| Cutover / DNS / rollback | — | Next PRs | Write-fenced final sync, reconciliation report, reversible cutover. DNS never moves before reconciliation passes. |

## Discovery & dry-run (connector groundwork)

Shipped as pure, unit-tested libraries in `src/lib/wordpress/` — the future
wizard wires UI and scheduling around them:

- `source-url.ts` — HTTPS-only source URLs; private/loopback/metadata hosts
  refused (SSRF guard).
- `client.ts` — read-only (GET) WP/Woo REST client: pagination, retry with
  backoff, credential redaction in every error/log surface.
- `discovery.ts` — authenticated `GET /wp-json/wp/v2/types?context=edit` and
  `/taxonomies?context=edit`. **Empty REST ≠ no content**: `show_in_rest=false`
  types produce a *blocking* warning demanding the agent/export fallback.
- `mapping.ts` — status map, money conversion (BigInt-exact), slug policy.
- `coverage.ts` — per-entity support classification; variable products,
  orders and customers currently classify as *unsupported-blocking*.
- `dry-run.ts` — combines discovery + coverage into the pre-flight report:
  every source object ends as *importable*, *archived with provenance*, or
  *visibly blocked* — the issue's first hard gate, before a single write.

## Data model (this PR)

Six tenant-scoped collections (admin group «انواع محتوا»): 
`content-type-definitions`, `content-entries`, `taxonomy-definitions`,
`taxonomy-terms`, `entry-term-relations`, `content-relations`. Every row
carries the same `source` provenance block (system, installation, source
type/id, mapping status, raw payload). The raw payload is staff-only:
anonymous reads never receive it nor `unmappedMeta`. Public URLs:
`/{archive}` type archive, entry permalinks per template, `/{taxonomy}`
index and `/{taxonomy}/{term…}` archives — resolved on a CMS-page miss, so
editor pages always win their own slugs.

Security invariants, proven in `tests/int/content-tenancy.int.spec.ts`:
cross-site wiring refused everywhere (entry↔type, term↔taxonomy, parents,
relations), anonymous reads see only the host site's published entries (and
relations only while their entry is public), publishing is owner-gated,
field values are type-checked against the definition, and the migration
context freezes stock/events on historical order replay — site-bound, so a
foreign stamp changes nothing.

## Hard gates (unchanged from the issue)

1. Every source record is imported, archived with provenance, or visibly
   blocked. Zero silent drops.
2. Exact order/line/total/tax/refund reconciliation before cutover.
3. Re-running an import creates zero duplicates (idempotency keys:
   site + source installation + source type + original ID).
4. No cross-tenant read or write, ever; credentials and PII never logged.
5. DNS moves only after the write fence + reconciliation pass; rollback
   stays possible until the customer accepts.

## Remaining work (follow-up PRs)

1. Migration job schema (`migration-jobs/-batches/-mappings/-records/
   -events/-errors/-redirects/-audits`) + wizard UI + dry-run engine over
   `src/lib/wordpress/`.
2. Commerce expansion: `customers` + addresses, product
   attributes/variations/galleries, multi-line orders with
   totals/tax/shipping/coupons/refunds (backward-compatible with the current
   checkout and theme API), then the historical importer on top of the
   migration context.
3. Live WP/Woo importer + delta sync (import order: definitions → terms
   parent-first → media → entries → fields → relations → redirects).
   Gutenberg→Lexical converter.
4. Redirect engine, cutover write fence, reconciliation, rollback.
