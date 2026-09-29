import { isShopSite } from '@/lib/siteKind'

import { collection, type NavEntityRef } from './navigation'

/**
 * The customer dashboard's link targets, described as typed entity references
 * instead of hand-written admin paths.
 *
 * `CustomerDashboard` used to spell each shortcut out as a string, and one of them
 * — «ویرایش پیمایش» — pointed at `/globals/header` while `header` is a
 * tenant-scoped *collection* (registered `isGlobal` with the multi-tenant plugin),
 * so the link answered 404. Describing the target as `{ type, slug }` and turning
 * it into a URL through the shared `entityHref`/`createHref` helpers makes that
 * class of bug unrepresentable, and lets a single config-level test
 * (`admin-dashboard-links.int.spec.ts`) prove every shortcut resolves to a
 * resource that actually exists, with the right kind of URL.
 */

/** A quick-action button. `create: true` links to the collection's New form. */
export type DashboardAction = {
  entity: NavEntityRef
  label: string
  create?: boolean
  /** Only offered on a shop (`type: 'store'`) site. Absent = every site. */
  shopOnly?: boolean
}

/** A stat tile: the counted collection and the label shown under its number. */
export type DashboardStat = {
  entity: NavEntityRef
  label: string
  /** Only counted and shown on a shop site. Absent = every site. */
  shopOnly?: boolean
}

/**
 * Quick actions, in display order. Every `create` action targets a collection a
 * customer may create in; «ویرایش پیمایش» opens the site's header collection —
 * the site navigation — at `/collections/header`, never `/globals/header`.
 *
 * A shop's products are its point; on a portfolio or business site the same
 * button is noise for a feature the site does not have, so it is `shopOnly`.
 */
export const CUSTOMER_QUICK_ACTIONS: DashboardAction[] = [
  { entity: collection('pages'), label: 'ساخت برگه', create: true },
  { entity: collection('posts'), label: 'ساخت نوشته', create: true },
  { entity: collection('media'), label: 'بارگذاری رسانه', create: true },
  { entity: collection('products'), label: 'افزودن محصول', create: true, shopOnly: true },
  { entity: collection('orders'), label: 'سفارش‌ها', shopOnly: true },
  { entity: collection('header'), label: 'ویرایش پیمایش' },
]

/** «یک نگاه به سایت» stat tiles, in display order. Each links to its list view. */
export const CUSTOMER_STAT_LINKS: DashboardStat[] = [
  { entity: collection('pages'), label: 'برگه‌ها' },
  { entity: collection('posts'), label: 'نوشته‌ها' },
  { entity: collection('media'), label: 'رسانه‌ها' },
  { entity: collection('products'), label: 'محصولات', shopOnly: true },
  { entity: collection('orders'), label: 'سفارش‌ها', shopOnly: true },
  { entity: collection('form-submissions'), label: 'پاسخ‌های فرم' },
]

/** Quick actions this site type gets. */
export const quickActionsFor = (siteType: null | string | undefined): DashboardAction[] =>
  CUSTOMER_QUICK_ACTIONS.filter((action) => !action.shopOnly || isShopSite(siteType))

/** Stat tiles this site type gets. */
export const statLinksFor = (siteType: null | string | undefined): DashboardStat[] =>
  CUSTOMER_STAT_LINKS.filter((stat) => !stat.shopOnly || isShopSite(siteType))

/**
 * Collections the dashboard counts. Always the full superset: the site type is only
 * known *after* the site row is read, and a count of a collection the site never
 * shows costs one indexed query, so the read is not made conditional on it.
 */
export const CUSTOMER_STAT_SLUGS = CUSTOMER_STAT_LINKS.map((s) => s.entity.slug)
