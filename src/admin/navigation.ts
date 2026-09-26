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
  /** Payload custom collection view path suffix (e.g. `/infrastructure/storage`). */
  viewPath?: string
}

export type NavGroupDef = {
  label: string
  entities: NavEntityRef[]
}

export const collection = (slug: string, label?: string, viewPath?: string): NavEntityRef => ({
  type: 'collection',
  slug,
  label,
  viewPath,
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
  if (ref.type === 'global') return `${base}/globals/${ref.slug}`
  if (ref.viewPath) return `${base}/collections/${ref.slug}${ref.viewPath}`
  return `${base}/collections/${ref.slug}`
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
      // Overview / products / orders / payments / settings order. «نمای کلی» is
      // not its own route — the store control-centre summary is rendered on the
      // dashboard by `storeOverview` (`CustomerDashboard.tsx`), so the products
      // list is the first destination here.
      collection('products'),
      collection('orders'),
      collection('payment-gateways', 'پرداخت'),
      collection('store', 'تنظیمات فروشگاه'),
    ],
  },
  {
    // «طراحی و انتشار» — design *and* publishing. A customer's only tenant-scoped
    // resource here is their theme (`theme`, one doc per site). Theme catalogue,
    // domain and deployment are all platform-owned collections
    // (`theme-templates`, `deploy-targets`, `site-deployments` — `hiddenFromCustomers`),
    // so they are not customer nav destinations; domain is edited on the site
    // settings screen. The group carries the product name so the section reads as
    // the customer's design & publishing home even though it fronts one collection.
    label: 'طراحی و انتشار',
    entities: [collection('theme', 'طراحی سایت')],
  },
  {
    label: 'تیم',
    entities: [collection('users', 'اعضای تیم')],
  },
  {
    // «تنظیمات» — general, languages, connections, advanced. These are tabs on the
    // one tenant-scoped settings document (`sites`), not separate routes: a
    // customer edits their locales, domain and advanced options in the site edit
    // view. API-key management is platform-owned (`api-keys` is `hiddenFromCustomers`).
    label: 'تنظیمات',
    entities: [collection('sites', 'تنظیمات سایت')],
  },
]

/**
 * The platform / operator console. Every entity here runs the SaaS. Supporting
 * history/event and per-site override tables (`usage-records`, `site-entitlements`,
 * `site-theme-settings`, `*-events`, `*-operations`, `webhook-deliveries`) are
 * deliberately NOT primary items: they are per-site/contextual detail, surfaced in
 * a site's Customer-360 report, and remain reachable through the «سایر» catch-all
 * (demoted, never deleted). The group order mirrors the product information
 * architecture: who the customers are, then the product catalogue,
 * then the infrastructure that runs it, then integrations, then day-to-day
 * operations, then the platform's own settings.
 */
export const PLATFORM_NAV: NavGroupDef[] = [
  {
    label: 'مشتریان',
    entities: [collection('sites'), collection('users')],
  },
  {
    // The product catalogue: features, themes, plugins. `site-theme-settings` is a
    // per-site override table, not a catalogue product — it belongs to a site's
    // context, so it is not a primary item here (still reachable via «سایر»).
    label: 'محصول',
    entities: [
      collection('feature-flags', 'قابلیت‌ها'),
      collection('theme-templates', 'پوسته‌ها'),
      collection('theme-packages', 'بسته‌های پوسته'),
      collection('plugins', 'افزونه‌ها'),
    ],
  },
  {
    // The resources that run the fleet: domains, CDN, storage, deploy targets,
    // payment policy. History/event tables that describe these resources
    // (`reseller-domain-operations`, `reseller-domain-events`, `cdn-events`) are
    // contextual detail, not primary infrastructure products, so they are demoted
    // to «سایر» rather than sitting beside the resource they log.
    label: 'زیرساخت',
    entities: [
      // Several of these carry table-oriented labels that read as noise at the top
      // level of Infrastructure («رکوردها», «نام‌سرورها»); clarified here without
      // touching the collection's own label (which stays correct in context).
      collection('reseller-domains', 'دامنه‌ها'),
      collection('domain-reseller-products', 'کاتالوگ TLD'),
      global('domain-reseller'),
      collection('cdn-zones', 'CDN — زون‌ها'),
      collection('storage-connections', 'ذخیره‌سازی اشیا', '/infrastructure/storage'),
      collection('deploy-targets', 'سرورهای انتشار'),
      // Platform payment policy — which gateway adapters are globally allowed —
      // is infrastructure, distinct from a customer's per-site gateway config.
      global('payments', 'پرداخت'),
    ],
  },
  {
    // Machine-to-machine surfaces. `webhook-deliveries` is a per-webhook attempt
    // log — contextual detail under a webhook, not a primary product — so it is
    // demoted to «سایر» rather than listed as a sibling of the webhook config.
    label: 'یکپارچه‌سازی',
    entities: [
      collection('api-keys'),
      collection('webhooks'),
      collection('billing-service-credentials', 'اعتبارنامهٔ صورت‌حساب'),
    ],
  },
  {
    // Day-to-day running of the fleet: deployments and the audit trail. Activity
    // and system-health are composed read-only views (`OperatorDashboard`,
    // `GET /api/platform/overview` + the events feed), not collections, so they
    // have no sidebar entity of their own.
    label: 'عملیات',
    entities: [
      collection('site-deployments', 'انتشارها'),
      collection('central-entitlement-projections', 'وضعیت تجاری'),
      collection('billing-usage-outbox', 'خروجی مصرف'),
      collection('audit-log', 'Audit'),
    ],
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
