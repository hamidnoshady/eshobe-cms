import { isPlatformAdmin } from '@/access/platformAdmin'

/**
 * The one place the admin sidebar's information architecture is described.
 *
 * Payload's stock nav groups entities by each collection's static `admin.group`
 * string, which has two limits this platform cannot live with:
 *
 *  1. `admin.group` is a single static value, so a collection shared by both
 *     audiences (`sites`, `users`) can only carry one label. A customer editing
 *     their own website should never read the operator's word for it
 *     («ناوگان» / fleet); an operator running the SaaS should never read the
 *     customer's. One string cannot be both.
 *  2. Good SaaS navigation is *product-oriented*, not table-oriented: "Forms" is
 *     one nav item backed by two collections (`forms`, `form-submissions`), and
 *     history/event tables (`cdn-events`, `webhook-deliveries`, …) belong beside
 *     their parent, not as first-class siblings.
 *
 * So the sidebar is driven by this map instead — see `EshobeNav`. `admin.hidden`
 * is still authoritative for *whether* an entity may appear (it is what
 * `getVisibleEntities` reads, and it is re-derived per user); this map only
 * decides *where* and *under what label* a visible entity is shown, per audience.
 * Anything visible that this map forgets still appears, under a catch-all group,
 * so a new collection can never become unreachable by omission.
 *
 * This is navigation only. Every real boundary is a collection/global `access`
 * function (`src/access/*`); nothing here grants or removes a permission.
 */

/** A reference to a Payload collection or global to place in the sidebar. */
export type NavEntityRef = {
  /** Optional label override — a product-oriented name that reads better than the
   *  collection's own label in this context (e.g. `store` → «تنظیمات فروشگاه»). */
  label?: string
  slug: string
  type: 'collection' | 'global'
}

export type NavGroupDef = {
  label: string
  entities: NavEntityRef[]
}

export const collection = (slug: string, label?: string): NavEntityRef => ({
  type: 'collection',
  slug,
  label,
})
export const global = (slug: string, label?: string): NavEntityRef => ({
  type: 'global',
  slug,
  label,
})

/** Strip the trailing slash Payload uses for a root-mounted admin (`routes.admin === '/'`). */
export const adminBase = (adminRoute: string): string => (adminRoute === '/' ? '' : adminRoute)

/**
 * The one place an admin URL for a Payload entity is spelled out. Every sidebar
 * link and every dashboard shortcut goes through this, so a resource's *type*
 * (collection vs global) — not a hand-typed path — decides its URL. This is what
 * makes it impossible to reintroduce the `/globals/header` bug: `header` is a
 * tenant-scoped collection registered `isGlobal` with the multi-tenant plugin, so
 * it lives at `/collections/header`; only a genuine Payload global gets `/globals`.
 */
export const entityHref = (adminRoute: string, ref: NavEntityRef): string => {
  const base = adminBase(adminRoute)
  return ref.type === 'collection'
    ? `${base}/collections/${ref.slug}`
    : `${base}/globals/${ref.slug}`
}

/** The `New …` route for a collection (globals have no create route). */
export const createHref = (adminRoute: string, slug: string): string =>
  `${adminBase(adminRoute)}/collections/${slug}/create`

/**
 * The customer / site-CMS sidebar. Every entity here is a site's own resource,
 * scoped to the tenant by the multi-tenant plugin. A customer never sees the
 * control plane.
 */
export const CUSTOMER_NAV: NavGroupDef[] = [
  {
    label: 'وب‌سایت',
    entities: [
      // `header`/`footer`/`theme`/`store` are collections registered `isGlobal`
      // with the multi-tenant plugin — one doc per site — so they live under
      // `/collections/*`, not `/globals/*`. Labels default to each entity's own
      // `labels.plural`; only override where the product name genuinely differs.
      collection('pages'),
      collection('header'),
      collection('footer'),
      collection('forms'),
      collection('form-submissions'),
      // SEO & search, then redirects — the «SEO و جستجو» / «تغییر مسیرها» pair.
      collection('search'),
      collection('redirects'),
    ],
  },
  {
    label: 'محتوا',
    entities: [collection('posts'), collection('categories'), collection('media')],
  },
  {
    label: 'فروشگاه',
    entities: [
      // Overview / products / orders / payments / settings order.
      collection('products'),
      collection('orders'),
      collection('payment-gateways', 'پرداخت'),
      collection('store', 'تنظیمات فروشگاه'),
    ],
  },
  {
    label: 'طراحی',
    entities: [collection('theme')],
  },
  {
    label: 'تیم',
    entities: [collection('users')],
  },
  {
    label: 'تنظیمات',
    entities: [collection('sites', 'تنظیمات سایت')],
  },
]

/**
 * The platform / operator console. Every entity here runs the SaaS. Supporting
 * history/event and per-site catalogue tables live beside their parent rather
 * than as top-level items — see the label overrides. The group order mirrors the
 * product information architecture: who the customers are, then money, then the
 * product catalogue, then the infrastructure that runs it, then integrations,
 * then day-to-day operations, then the platform's own settings.
 */
export const PLATFORM_NAV: NavGroupDef[] = [
  {
    label: 'مشتریان',
    entities: [collection('sites'), collection('users')],
  },
  {
    label: 'اشتراک و مالی',
    entities: [
      collection('plans'),
      collection('subscriptions'),
      collection('invoices'),
      // Usage & entitlements are per-customer detail; until the Customer-360 view
      // lands they stay here (kept reachable) rather than as top-level siblings.
      collection('usage-records'),
      collection('site-entitlements'),
    ],
  },
  {
    label: 'محصول',
    entities: [
      collection('feature-flags', 'قابلیت‌ها'),
      collection('theme-templates'),
      collection('theme-packages'),
      collection('site-theme-settings'),
      collection('plugins'),
    ],
  },
  {
    label: 'زیرساخت',
    entities: [
      // Several of these carry table-oriented labels that read as noise at the top
      // level of Infrastructure («رکوردها», «نام‌سرورها»); clarified here without
      // touching the collection's own label (which stays correct in context).
      collection('reseller-domains', 'دامنه‌ها'),
      collection('domain-reseller-products', 'کاتالوگ TLD'),
      global('domain-reseller'),
      collection('reseller-domain-operations'),
      collection('reseller-domain-events'),
      collection('cdn-zones', 'CDN — زون‌ها'),
      collection('cdn-events'),
      collection('storage-connections'),
      collection('deploy-targets', 'سرورهای انتشار'),
      // Platform payment policy — which gateway adapters are globally allowed —
      // is infrastructure, distinct from a customer's per-site gateway config.
      global('payments', 'پرداخت'),
    ],
  },
  {
    label: 'یکپارچه‌سازی',
    entities: [collection('api-keys'), collection('webhooks'), collection('webhook-deliveries')],
  },
  {
    label: 'عملیات',
    entities: [collection('site-deployments', 'انتشارها'), collection('audit-log')],
  },
  {
    label: 'تنظیمات سکو',
    entities: [global('platform-settings')],
  },
]

/** Group name for any visible entity this map did not place — see the file header. */
export const OTHER_GROUP_LABEL = 'سایر'

export type ResolvedNavEntity = NavEntityRef & { id: string; href: string }
export type ResolvedNavGroup = { label: string; entities: ResolvedNavEntity[] }

/**
 * Turn the audience's map into a rendered group list: choose the map by role,
 * keep only entities the user may actually see (`visibleEntities`, itself derived
 * from `admin.hidden`), and sweep anything visible-but-unplaced into one trailing
 * group so nothing is ever silently unreachable.
 */
export const resolveNavGroups = ({
  adminRoute,
  user,
  visible,
}: {
  adminRoute: string
  user: unknown
  visible: { collections: string[]; globals: string[] }
}): ResolvedNavGroup[] => {
  const map = isPlatformAdmin(user) ? PLATFORM_NAV : CUSTOMER_NAV
  const visibleCollections = new Set(visible.collections)
  const visibleGlobals = new Set(visible.globals)

  const isVisible = (e: NavEntityRef) =>
    e.type === 'collection' ? visibleCollections.has(e.slug) : visibleGlobals.has(e.slug)

  const hrefFor = (e: NavEntityRef): string => entityHref(adminRoute, e)
  const idFor = (e: NavEntityRef) => (e.type === 'collection' ? `nav-${e.slug}` : `nav-global-${e.slug}`)

  const placed = new Set<string>()
  const key = (e: NavEntityRef) => `${e.type}:${e.slug}`

  const groups: ResolvedNavGroup[] = map
    .map((group) => ({
      label: group.label,
      entities: group.entities
        .filter((e) => {
          if (!isVisible(e)) return false
          placed.add(key(e))
          return true
        })
        .map((e) => ({ ...e, href: hrefFor(e), id: idFor(e) })),
    }))
    .filter((group) => group.entities.length > 0)

  // Anything visible the map did not place (a new collection, or the operator's
  // `PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS` escape hatch putting content back).
  const leftovers: ResolvedNavEntity[] = []
  for (const slug of visible.collections) {
    const e = collection(slug)
    if (!placed.has(key(e))) leftovers.push({ ...e, href: hrefFor(e), id: idFor(e) })
  }
  for (const slug of visible.globals) {
    const e = global(slug)
    if (!placed.has(key(e))) leftovers.push({ ...e, href: hrefFor(e), id: idFor(e) })
  }
  if (leftovers.length > 0) groups.push({ label: OTHER_GROUP_LABEL, entities: leftovers })

  return groups
}
