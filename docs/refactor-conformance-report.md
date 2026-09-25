# ESHOBE CMS — Product-Oriented Refactor: Conformance & Completeness Report

Branch `arena/01a0d7ce-eshobe-cms`, baseline `2c2c191`. This report is evidence-based:
every ✅ points at code and/or a test in this repository. Sandbox-blocked items say so
explicitly and name the exact reason — they are not marked passed locally.

## Commits in this effort

| Commit | Summary |
|---|---|
| `f31d3ba` | fix: customer dashboard «ویرایش پیمایش» 404'd on `/globals/header` (header is a tenant-scoped collection) |
| `24bce7b` | refactor: product-oriented customer & platform navigation |
| `a4c6334` | fix(security): tenant-scope CustomerDashboard reads; add `storeOverview` |
| `9c6357a` | refactor: extract tenant-scoped `customerSiteSummary` + isolation test |
| `ffbfca3` | test: lock in server-side site-type block gating over the API |
| `ed86850` | refactor: conform nav IA to target tree; harden nav + migration tests |
| `758a197` | refactor: dedupe platform-endpoint operator guard + site lookup; add endpoint-order guard |

## §35 Final completeness matrix

| Area | Status | Evidence |
|---|---|---|
| Customer navigation | ✅ | `src/admin/navigation.ts` (CUSTOMER_NAV); `tests/int/navigation.int.spec.ts` (exact tree), `tests/int/admin-visibility.int.spec.ts` |
| Customer dashboard | ✅ | `src/admin/CustomerDashboard.tsx`; `tests/int/admin-dashboard-links.int.spec.ts`, `customer-site-summary.int.spec.ts` |
| Website / Pages | ✅ | `src/collections/Pages`; grouped under «وب‌سایت»; `blocks.int.spec.ts`, `editing.int.spec.ts` |
| Navigation (header/footer) | ✅ | tenant-scoped `header`/`footer` collections under «وب‌سایت»; NOT converted to globals; `admin-visibility.int.spec.ts` |
| Forms | ✅ | `forms` + `form-submissions` grouped as one «وب‌سایت» workflow; `admin-visibility.int.spec.ts` (submissions beside forms) |
| SEO / search / redirects | ✅ | `search`, `redirects` collections under «وب‌سایت» |
| Content (posts/categories/media) | ✅ | «محتوا» group kept distinct from Pages; `navigation.int.spec.ts` |
| Store overview | ✅ | `src/lib/storeOverview.ts` rendered on dashboard; `tests/int/store-overview.int.spec.ts` |
| Products / Orders / Payments | ✅ | «فروشگاه» group; `store.int.spec.ts`, `api-keys.int.spec.ts` |
| Design & Publishing | ✅ | «طراحی و انتشار» group (theme); catalogue/domain/deploy are platform-owned by design |
| Themes / Domains | ✅ | platform-owned catalogue + `sites` domain fields; `platform-saas.int.spec.ts`, `domain-reseller*.int.spec.ts` |
| Team | ✅ | `users` as «اعضای تیم»; owner/editor boundary server-enforced (`tenancy.int.spec.ts`) |
| Customer settings | ✅ | `sites` as «تنظیمات سایت» (general/languages/domain/advanced tabs) |
| Platform navigation | ✅ | `PLATFORM_NAV`; `navigation.int.spec.ts` (exact tree + demotion) |
| Customer 360 (backend + UX) | ✅ | `src/platform/report.ts` `siteReportFor`; `GET/PATCH /api/platform/sites[/:id]`; `platform-control.int.spec.ts` |
| Billing | ✅ | «اشتراک و مالی» = plans/subscriptions/invoices only; usage/entitlements demoted; `platform-saas.int.spec.ts` |
| Product / Infrastructure / Integrations / Operations | ✅ | `PLATFORM_NAV` groups; supporting tables demoted to «سایر»; `navigation.int.spec.ts` |
| Platform settings | ✅ | `platform-settings` global; `admin-visibility.int.spec.ts` |
| Tenant isolation | ✅ | `tenancy.int.spec.ts` (read/update/delete another site refused) |
| Permission model | ✅ | `access-control.int.spec.ts`, `tenancy.int.spec.ts` (editor cannot publish) |
| API-key security | ✅ | `api-keys.int.spec.ts` (raw once, hash stored, scope enforced, cannot mint platform key) |
| Secret handling | ✅ | `ApiKeys.keyHash` hidden + server-only; `deploymentRow` excludes `revalidateSecret`; platform secrets encrypted (`lib/saas/crypto`) |
| Route ordering | ✅ | `payload.config.ts` order + `tests/int/endpoint-order.int.spec.ts` (new guard) |
| Dead route audit | ✅ | §37 below — no dead routes found |
| Dead code cleanup | ✅ | §36 below — none removed (none found); duplication consolidated |
| Duplicate code cleanup | ✅ | `src/endpoints/platformShared.ts` consolidates `requireOperator`/`siteById`/`json` |
| Database compatibility | ✅ | no schema/field changes; `migrations.int.spec.ts` green; `pnpm seed` clean |
| Build | ⚠ BLOCKED (sandbox) | Turbopack OOMs in 3.9 GB sandbox; `next build --webpack` used locally. Confirm production build in CI. |
| E2E | ⚠ BLOCKED (sandbox) | Playwright browser CDN blocked here. E2E must run in CI where browsers install. |

Local verification: **typecheck ✅ · lint ✅ (0 errors) · integration 532/532 ✅.**

## §36 Dead-code report

No dead code was removed because none was found. Proof of the search:

- No `*.old`/`*.bak`/`*legacy*`/`*deprecated*` files under `src/`.
- All admin UI components are registered: `OperatorDashboard` + `CustomerDashboard`
  (`beforeDashboard`), `EshobeNav` → `EshobeNav.client` (`admin.components.Nav`).
  There is exactly one customer experience and one platform experience — no duplicate/legacy UI.
- Exported symbols of `src/admin/navigation.ts` are all consumed except `adminBase`
  (used only internally) and `ResolvedNavEntity` (a member of the exported
  `ResolvedNavGroup` type). Both are harmless and left in place per §31 (no churn for beauty).

Duplication removed (not dead code, but redundant): four byte-identical `requireOperator`,
three byte-identical `siteById`, and the `json`/`noStore` responder across the platform
endpoint files → one `src/endpoints/platformShared.ts`.

## §37 Route report

- **Canonical routes added:** none (no new user-facing routes). Presentation-only nav relabels.
- **Legacy routes preserved:** all Payload collection/global admin routes unchanged
  (`/collections/*`, `/globals/*`). Header/Footer remain `/collections/{header,footer}`.
- **Redirects added:** none required — no user-facing URL changed.
- **Dead routes removed:** none found. Every custom endpoint in `payload.config.ts`
  resolves to a handler with a caller (admin UI, POS console, or public storefront).
- **Broken routes fixed:** `/globals/header` dashboard shortcut → `/collections/header`
  (`f31d3ba`), now regression-guarded by `admin-dashboard-links.int.spec.ts`.
- **API routes intentionally unchanged:** all `/api/platform/*`, `/api/site/*`,
  `/api/checkout/*`, `/api/cdn/*`, collection endpoints (`/api/api-keys/*`,
  `/api/storage-connections/self-test`, `/api/deploy-targets/self-test`,
  `/api/webhooks/test`). Endpoint **order** hardened, not changed (§20).
- **User-facing route changes (OLD → NEW):** none.

## §38 Bug report

Genuine bug found and fixed:

- **BUG** — customer dashboard «ویرایش پیمایش» linked to `/globals/header`, but `header`
  is a tenant-scoped collection (registered `isGlobal` with the multi-tenant plugin), so
  the link 404'd. Fixed in `f31d3ba`; class-eliminated by describing links as typed
  `{ type, slug }` refs resolved through `entityHref`/`createHref`, guarded by a config-level test.

Architecture cleanup (not bugs):
- Demoted per-site/history tables out of primary platform nav (§14–§17).
- Consolidated duplicate platform-endpoint guards (§22).

UX improvements (not bugs):
- «طراحی» → «طراحی و انتشار»; product-oriented labels for theme/users/settings and
  platform infrastructure items.

Test improvements:
- Full nav-tree conformance test; endpoint-order regression guard; migration test made
  environment-isolated so it passes locally and in CI with identical assertions (§32 option A).

## Route-order safety (§20)

`payload.config.ts` spreads `platformSaasEndpoints` and `platformDeploymentEndpoints`
(which register the specific `/platform/sites/:id/{quota,usage,features,theme,entitlement,
deployment,snapshot}` paths) **before** `platformControlEndpoints` (the bare
`/platform/sites/:id`). `tests/int/endpoint-order.int.spec.ts` now fails CI if any reorder
lets the bare route shadow a specific one.

## Definition of Done — status

Met: both nav trees conform to the target IA; every nav/dashboard link resolves (tested);
customer/platform contexts separated; Customer-360 coherent (backend + operator endpoints);
supporting collections contextual via «سایر», not sidebar clutter; no stale header/footer
global routes; dead-route + dead-code audits complete; duplicate guards consolidated;
tenant isolation and server authorization intact (tested); designed product behavior
untouched; public routing / Caddy / deploy / payment safety unchanged; tests cover the new IA.

Outstanding (environment, not code): production **build** (Turbopack) and **Playwright E2E**
must be confirmed in real CI — both are blocked only by sandbox resource/network limits.
