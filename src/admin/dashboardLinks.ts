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
}

/** A stat tile: the counted collection and the label shown under its number. */
export type DashboardStat = {
  entity: NavEntityRef
  label: string
}

/**
 * Quick actions, in display order. Every `create` action targets a collection a
 * customer may create in; «ویرایش پیمایش» opens the site's header collection —
 * the site navigation — at `/collections/header`, never `/globals/header`.
 */
export const CUSTOMER_QUICK_ACTIONS: DashboardAction[] = [
  { entity: collection('pages'), label: 'ساخت برگه', create: true },
  { entity: collection('posts'), label: 'ساخت نوشته', create: true },
  { entity: collection('media'), label: 'بارگذاری رسانه', create: true },
  { entity: collection('products'), label: 'افزودن محصول', create: true },
  { entity: collection('header'), label: 'ویرایش پیمایش' },
]

/** «یک نگاه به سایت» stat tiles, in display order. Each links to its list view. */
export const CUSTOMER_STAT_LINKS: DashboardStat[] = [
  { entity: collection('pages'), label: 'برگه‌ها' },
  { entity: collection('posts'), label: 'نوشته‌ها' },
  { entity: collection('products'), label: 'محصولات' },
  { entity: collection('orders'), label: 'سفارش‌ها' },
  { entity: collection('form-submissions'), label: 'پاسخ‌های فرم' },
]

/** Collections the dashboard shows a live count for — exactly the stat tiles. */
export const CUSTOMER_STAT_SLUGS = CUSTOMER_STAT_LINKS.map((s) => s.entity.slug)
