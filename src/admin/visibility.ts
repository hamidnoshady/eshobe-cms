import type { ClientUser } from 'payload'

import type { User } from '@/payload-types'

import { isPlatformAdmin } from '@/access/platformAdmin'

/**
 * Who sees which collections in `/admin`.
 *
 * The panel has two audiences and they want opposite things. A **customer's** staff
 * edit one website: pages, posts, media, products, orders. A **platform operator**
 * does not edit anybody's website — they run the SaaS: sites, plans, subscriptions,
 * invoices, quotas, API keys, plugins, themes, CDN, object storage, webhooks,
 * feature flags, the audit trail. Showing both lists to both audiences is what made
 * the operator's panel unusable: «برگه‌ها» for twenty customers at once is not a
 * screen anybody wants, and it buries the six screens that actually run the
 * business.
 *
 * So `admin.hidden` splits the nav by role. Two things it deliberately is **not**:
 *
 *  - **Not access control.** `admin.hidden` governs the nav and the admin routes
 *    only; REST, GraphQL and the Local API are untouched. That is the correct
 *    layering here — a platform admin must still be able to read every site's
 *    content through `/api/platform/sites/:id/snapshot`, and every real boundary in
 *    this codebase is a collection `access` function (`src/access/*`), not a UI
 *    flag. Nothing below grants anyone anything they did not already have.
 *  - **Not a deletion.** The content collections still exist, still carry their
 *    tenant scope, and are still edited by the customer's own staff. Removing them
 *    from the config would turn this deployment into a control plane with no CMS
 *    under it.
 *
 * `PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS=true` puts the content collections back in
 * a platform admin's nav. It exists for two real cases: an operator doing hands-on
 * support inside a customer's content, and the e2e suite, whose fixture user is a
 * platform admin and whose subject is the *editing* experience
 * (`tests/e2e/admin.e2e.spec.ts` — `playwright.config.ts` sets it for that reason).
 */
const showSiteCollectionsToOperators = (): boolean =>
  process.env.PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS === 'true'

// Both collection `admin.hidden` (`{ user: ClientUser }`) and global `admin.hidden`
// (`{ user: User | null }`) share these helpers, so the arg accepts either shape.
type HiddenArgs = { user: ClientUser | User | null }

/**
 * A site-content collection: visible to a customer's staff, hidden from the
 * operator console unless the escape hatch above is set.
 */
export const hiddenFromOperators = ({ user }: HiddenArgs): boolean =>
  isPlatformAdmin(user) && !showSiteCollectionsToOperators()

/**
 * A control-plane collection: visible to platform staff only.
 *
 * Every collection that uses this also has `access.read: platformAdmin`, so for a
 * customer this only removes a nav entry that would answer 403 anyway. Stating it
 * twice is deliberate: an empty list with a permission error is a support ticket.
 */
export const hiddenFromCustomers = ({ user }: HiddenArgs): boolean => !isPlatformAdmin(user)

/**
 * Group labels shown on the operator console's collection breadcrumbs.
 *
 * The sidebar itself is now driven by `src/admin/navigation.ts` (via the custom
 * `EshobeNav`), which models finer, product-oriented groups per audience. These
 * constants remain the value each control-plane collection carries in
 * `admin.group`, so the label pill on a list/edit view stays coherent; they are
 * kept deliberately in step with the platform sidebar's top-level sections.
 *
 * The old «سکو —» prefix is gone: it only ever showed to operators, for whom the
 * whole console *is* the platform, so the prefix was noise.
 */
export const PLATFORM_GROUPS = {
  /** Sites, users, keys — who exists on this deployment. */
  fleet: 'مشتریان',
  /** Plans, subscriptions, invoices, usage. */
  billing: 'اشتراک و صورت‌حساب',
  /** Plugins, themes, feature flags. */
  extensions: 'پوسته‌ها و افزونه‌ها',
  /** Storage, CDN, domains, registrar. */
  infrastructure: 'زیرساخت',
  /** Webhooks, audit, settings. */
  operations: 'عملیات',
} as const

/** The nav group every site-content collection shares, so a customer's panel reads as one section. */
export const SITE_CONTENT_GROUP = 'محتوای سایت'
