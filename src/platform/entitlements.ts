import type { PayloadRequest, Where } from 'payload'

import { billingCutoverPhase } from '@/billing/cutover'
import { applyTechnicalGate } from '@/billing/entitlement/features'
import { limitsToQuota, type LimitMap } from '@/billing/entitlement/limits'
import { readProjection } from '@/billing/entitlement/store'
import { storageBytesForSite } from '@/billing/meters/storage-account'
import {
  buildQuotaReport,
  currentMonthWindow,
  featureMap,
  isEntitled,
  normalizeLimit,
  QUOTA_METRICS,
  resolveFeatures,
  type FeatureCatalogueEntry,
  type QuotaLimits,
  type QuotaMetric,
  type QuotaReport,
  type ResolvedFeature,
  type UsageCounts,
} from '@/lib/saas/plans'

/**
 * "What does this site actually have?" — answered in exactly one place.
 *
 * Three layers feed in (plan → subscription → per-site entitlement) and four
 * consumers read the answer out: the admin dashboard, `GET /api/platform/sites/:id/entitlement`,
 * `GET /api/site` (the part a renderer may see) and the quota enforcement hook. Any
 * second implementation of this merge is how two screens start disagreeing about
 * whether a customer has paid for something.
 *
 * Every read here is `overrideAccess: true` and that is deliberate: entitlement is
 * resolved *for* a site, by callers who have already been authorised (a platform
 * operator, or the site's own descriptor endpoint which resolved the tenant from
 * `Host`). A tenant-scoped read would make the answer depend on who is asking,
 * which is the one thing a quota must never do.
 */

export type SiteEntitlement = {
  /** `projection` once central Billing has delivered a version. `legacy` is the read-only fallback. */
  authority: 'legacy' | 'projection'
  features: ResolvedFeature[]
  featureMap: Record<string, boolean>
  limits: QuotaLimits
  plan: null | { code: string; id: string; interval: string; name: string }
  projectionVersion: null | number
  quotaEnforcement: 'enforce' | 'off' | 'warn'
  /** Commercial serving. A technical site suspension is `sites.status`, not this flag. */
  serving: boolean
  site: { domain: string; id: string; name: string }
  subscription: null | {
    currentPeriodEnd: null | string
    id: string
    status: string
  }
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** The live subscription for a site, or `null`. `oneSubscriptionPerSite` is what makes "the" meaningful. */
export const subscriptionForSite = async (
  req: PayloadRequest,
  siteId: string,
): Promise<null | Record<string, unknown>> => {
  const { docs } = await req.payload.find({
    collection: 'subscriptions',
    depth: 1,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    sort: '-createdAt',
    where: {
      and: [{ site: { equals: siteId } }, { status: { in: ['trialing', 'active', 'pastDue', 'suspended'] } }],
    },
  })
  return (docs[0] as unknown as Record<string, unknown>) ?? null
}

const entitlementDocFor = async (
  req: PayloadRequest,
  siteId: string,
): Promise<null | Record<string, unknown>> => {
  const { docs } = await req.payload.find({
    collection: 'site-entitlements',
    depth: 1,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { site: { equals: siteId } },
  })
  return (docs[0] as unknown as Record<string, unknown>) ?? null
}

/**
 * Merge the plan's limits with the two override layers.
 *
 * Only keys that are *actually set* override — `normalizeLimit` turns blank, zero
 * and unparseable into `null`, and a `null` from an override layer means "I have no
 * opinion", not "unlimited". Without that distinction an empty override group
 * (which Payload writes for every saved document) would wipe the plan's numbers on
 * the first save of an unrelated field.
 */
export const mergeLimits = (
  planLimits: unknown,
  ...overrides: unknown[]
): QuotaLimits => {
  const result: QuotaLimits = {}

  for (const metric of QUOTA_METRICS) {
    const planValue = normalizeLimit((planLimits as Record<string, unknown> | null)?.[metric])
    if (planValue !== null) result[metric] = planValue
  }

  for (const layer of overrides) {
    if (!layer || typeof layer !== 'object') continue
    for (const metric of QUOTA_METRICS) {
      const value = normalizeLimit((layer as Record<string, unknown>)[metric])
      if (value !== null) result[metric] = value
    }
  }

  return result
}

/**
 * The pre-cutover merge: local plan, local subscription, local overrides.
 * Still the answer for a site that has no projection yet, and for `BILLING_CUTOVER=legacy|dual`.
 * It does not write commercial state.
 */
export const resolveLegacyEntitlement = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
): Promise<SiteEntitlement> => {
  const siteId = String(site.id)

  const [subscription, entitlementDoc, catalogue, settings] = await Promise.all([
    subscriptionForSite(req, siteId),
    entitlementDocFor(req, siteId),
    req.payload
      .find({
        collection: 'feature-flags',
        depth: 0,
        limit: 500,
        overrideAccess: true,
        pagination: false,
        req,
      })
      .then(({ docs }) =>
        docs.map(
          (doc): FeatureCatalogueEntry => ({
            defaultEnabled: (doc as { defaultEnabled?: unknown }).defaultEnabled === true,
            key: String((doc as { key?: unknown }).key ?? ''),
            label: (doc as { label?: null | string }).label ?? null,
          }),
        ),
      )
      .catch(() => [] as FeatureCatalogueEntry[]),
    req.payload
      .findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req })
      .catch(() => null),
  ])

  const planDoc = (subscription?.plan ?? null) as null | Record<string, unknown>
  const serving = isEntitled(subscription?.status)

  // Plan features are relationship documents at depth 1; a plan whose feature rows
  // were deleted still resolves, it just grants nothing extra.
  const planFeatureKeys = asArray<Record<string, unknown> | string>(planDoc?.features)
    .map((value) => (typeof value === 'string' ? value : String(value?.key ?? '')))
    .filter(Boolean)

  const siteOverrides = asArray<Record<string, unknown>>(entitlementDoc?.features)
    .map((row) => {
      const feature = row?.feature
      const key = typeof feature === 'string' ? feature : String((feature as { key?: unknown })?.key ?? '')
      return key ? { enabled: row?.enabled === true, key } : null
    })
    .filter((row): row is { enabled: boolean; key: string } => row !== null)

  const features = resolveFeatures({
    catalogue,
    // A plan grants nothing while the subscription is not serving. Otherwise a
    // cancelled customer keeps every paid feature until somebody notices.
    planFeatures: serving ? planFeatureKeys : [],
    siteOverrides,
  })

  const limits = mergeLimits(
    planDoc?.limits,
    subscription?.limitOverrides,
    entitlementDoc?.limitOverrides,
  )

  const siteEnforcement = String(entitlementDoc?.quotaEnforcement ?? 'inherit')
  const platformEnforcement = String(
    (settings as { quotaEnforcement?: unknown } | null)?.quotaEnforcement ?? 'warn',
  )
  const quotaEnforcement = (
    siteEnforcement === 'inherit' ? platformEnforcement : siteEnforcement
  ) as SiteEntitlement['quotaEnforcement']

  return {
    authority: 'legacy',
    featureMap: featureMap(features),
    features,
    limits,
    plan: planDoc
      ? {
          code: String(planDoc.code ?? ''),
          id: String(planDoc.id ?? ''),
          interval: String(planDoc.interval ?? 'monthly'),
          name: String(planDoc.name ?? ''),
        }
      : null,
    projectionVersion: null,
    quotaEnforcement: ['enforce', 'off', 'warn'].includes(quotaEnforcement) ? quotaEnforcement : 'warn',
    serving,
    site: { domain: String(site.domain ?? ''), id: siteId, name: String(site.name ?? '') },
    subscription: subscription
      ? {
          currentPeriodEnd:
            typeof subscription.currentPeriodEnd === 'string' ? subscription.currentPeriodEnd : null,
          id: String(subscription.id),
          status: String(subscription.status ?? ''),
        }
      : null,
  }
}

const holdKeys = (doc: null | Record<string, unknown>): string[] => {
  const raw = doc?.technicalHolds
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => {
      if (typeof row === 'string') return row
      if (row && typeof row === 'object' && 'key' in row) return String((row as { key?: unknown }).key ?? '')
      return ''
    })
    .filter(Boolean)
}

const enforcementOf = (
  entitlementDoc: null | Record<string, unknown>,
  settings: unknown,
): SiteEntitlement['quotaEnforcement'] => {
  const siteEnforcement = String(entitlementDoc?.quotaEnforcement ?? 'inherit')
  const platformEnforcement = String((settings as { quotaEnforcement?: unknown } | null)?.quotaEnforcement ?? 'warn')
  const quotaEnforcement = siteEnforcement === 'inherit' ? platformEnforcement : siteEnforcement
  return ['enforce', 'off', 'warn'].includes(quotaEnforcement) ? (quotaEnforcement as SiteEntitlement['quotaEnforcement']) : 'warn'
}

const resolveFromProjection = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  projection: Record<string, unknown>,
): Promise<SiteEntitlement> => {
  const siteId = String(site.id)
  const [entitlementDoc, catalogue, settings] = await Promise.all([
    entitlementDocFor(req, siteId),
    req.payload
      .find({
        collection: 'feature-flags',
        depth: 0,
        limit: 500,
        overrideAccess: true,
        pagination: false,
        req,
      })
      .then(({ docs }) =>
        docs.map((doc) => ({
          key: String((doc as { key?: unknown }).key ?? ''),
          label: (doc as { label?: null | string }).label ?? null,
          technicallyAvailable: (doc as { technicallyAvailable?: unknown }).technicallyAvailable !== false,
        })),
      )
      .catch(() => [] as { key: string; label: null | string; technicallyAvailable: boolean }[]),
    req.payload.findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req }).catch(() => null),
  ])

  const commercial =
    projection.features && typeof projection.features === 'object' && !Array.isArray(projection.features)
      ? (projection.features as Record<string, boolean>)
      : {}
  const gated = applyTechnicalGate({
    catalogue,
    commercial,
    holds: holdKeys(entitlementDoc),
  })
  const features: ResolvedFeature[] = gated.map((feature) => ({
    enabled: feature.enabled,
    key: feature.key,
    label: feature.label,
    source: feature.layer === 'projection' ? 'plan' : 'site',
  }))
  const limits = limitsToQuota(
    projection.limits && typeof projection.limits === 'object' ? (projection.limits as LimitMap) : {},
  )
  const planCode = typeof projection.planCode === 'string' ? projection.planCode : ''

  return {
    authority: 'projection',
    featureMap: featureMap(features),
    features,
    limits,
    plan: planCode ? { code: planCode, id: '', interval: '', name: planCode } : null,
    projectionVersion: Number(projection.version ?? 0) || null,
    quotaEnforcement: enforcementOf(entitlementDoc, settings),
    serving: projection.serving === true,
    site: { domain: String(site.domain ?? ''), id: siteId, name: String(site.name ?? '') },
    subscription: {
      currentPeriodEnd: typeof projection.billingCycleEnd === 'string' ? projection.billingCycleEnd : null,
      id: '',
      status: typeof projection.subscriptionStatus === 'string' ? projection.subscriptionStatus : '',
    },
  }
}

/** The answer every hot path reads. No HTTP call to central Billing. */
export const resolveEntitlement = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
): Promise<SiteEntitlement> => {
  const phase = billingCutoverPhase()
  const siteId = String(site.id)
  const projection = phase === 'legacy' ? null : await readProjection(req, siteId).catch(() => null)

  if (phase === 'dual' && projection) {
    const legacy = await resolveLegacyEntitlement(req, site)
    const { compareEntitlement } = await import('@/billing/migration/report')
    const mismatches = compareEntitlement(siteId, legacy, projection)
    if (mismatches.length > 0) {
      req.payload.logger.warn({ mismatches, msg: 'billing dual-read mismatch', siteId })
    }
    return legacy
  }

  if (projection && phase === 'central') return resolveFromProjection(req, site, projection)
  return resolveLegacyEntitlement(req, site)
}

const countFor = async (req: PayloadRequest, collection: string, where: Where): Promise<number> => {
  try {
    const { totalDocs } = await req.payload.count({
      collection: collection as Parameters<PayloadRequest['payload']['count']>[0]['collection'],
      overrideAccess: true,
      req,
      where,
    })
    return totalDocs
  } catch {
    // A collection missing mid-migration must not take a quota screen down; -1 would
    // look like a real number, 0 reads as "nothing yet", which is the safer lie for a
    // *limit* check (it never blocks a customer on a failed read).
    return 0
  }
}

/**
 * Current usage per metric for one site.
 *
 * Lifetime metrics are counted from the content tables, which is always correct and
 * needs no bookkeeping. Windowed ones (`ordersPerMonth`, `apiRequestsPerMonth`) come
 * from `usage-records` for API calls, and from a windowed `count` for orders — an
 * order *is* a row, so counting it is both exact and free, and a counter for it
 * would be a second source of truth that can drift from the orders themselves.
 *
 * `mediaStorageMb` sums `media.filesize` over a capped page scan for the same reason
 * `windowedRevenue` does in the fleet report: Payload has no aggregate, and raw SQL
 * stays in migrations.
 */
export const usageForSite = async (req: PayloadRequest, siteId: string): Promise<UsageCounts> => {
  const scoped: Where = { site: { equals: siteId } }
  const { end, start } = currentMonthWindow()
  const period = start.slice(0, 7)

  const [pages, posts, products, media, categories, users, apiKeys, ordersThisMonth, domains] =
    await Promise.all([
      countFor(req, 'pages', scoped),
      countFor(req, 'posts', scoped),
      countFor(req, 'products', scoped),
      countFor(req, 'media', scoped),
      countFor(req, 'categories', scoped),
      countFor(req, 'users', { 'tenants.tenant': { equals: siteId } }),
      countFor(req, 'api-keys', { and: [{ site: { equals: siteId } }, { disabledAt: { exists: false } }] }),
      countFor(req, 'orders', {
        and: [
          { site: { equals: siteId } },
          { createdAt: { greater_than_equal: start } },
          { createdAt: { less_than: end } },
        ],
      }),
      req.payload
        .findByID({ id: siteId, collection: 'sites', depth: 0, disableErrors: true, overrideAccess: true, req })
        .then((doc) => 1 + (Array.isArray((doc as { domains?: unknown[] } | null)?.domains) ? (doc as { domains: unknown[] }).domains.length : 0))
        .catch(() => 1),
    ])

  const apiRequests = await req.payload
    .find({
      collection: 'usage-records',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [
          { site: { equals: siteId } },
          { metric: { equals: 'apiRequestsPerMonth' } },
          { period: { equals: period } },
        ],
      },
    })
    .then(({ docs }) => Number((docs[0] as { value?: unknown } | undefined)?.value ?? 0) || 0)
    .catch(() => 0)

  return {
    apiKeys,
    apiRequestsPerMonth: apiRequests,
    categories,
    domains,
    media,
    mediaStorageMb: await mediaStorageMb(req, siteId),
    ordersPerMonth: ordersThisMonth,
    pages,
    posts,
    products,
    users,
  }
}

/**
 * Quota display for storage. Prefers the maintained byte total. The capped scan
 * is only the fallback before that total exists, and it is approximate — it is
 * not the billable `cms.storage_byte_hour` meter.
 */
const MEDIA_SCAN_PAGES = 20

const mediaStorageMb = async (req: PayloadRequest, siteId: string): Promise<number> => {
  const exact = await storageBytesForSite(req, siteId).catch(() => null)
  if (exact != null) return Math.round(exact / (1024 * 1024))

  let bytes = 0
  let page = 1

  for (; page <= MEDIA_SCAN_PAGES; page += 1) {
    const result = await req.payload
      .find({
        collection: 'media',
        depth: 0,
        limit: 500,
        overrideAccess: true,
        page,
        req,
        select: { filesize: true },
        where: { site: { equals: siteId } },
      })
      .catch(() => null)

    if (!result) return Math.round(bytes / (1024 * 1024))
    for (const doc of result.docs as { filesize?: unknown }[]) {
      bytes += Number(doc?.filesize ?? 0) || 0
    }
    if (!result.hasNextPage) break
  }

  return Math.round(bytes / (1024 * 1024))
}

/** Entitlement + usage, as the quota screen and the quota endpoint both want it. */
export const quotaReportForSite = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
): Promise<{ entitlement: SiteEntitlement; report: QuotaReport; usage: UsageCounts }> => {
  const entitlement = await resolveEntitlement(req, site)
  const usage = await usageForSite(req, String(site.id))
  const settings = await req.payload
    .findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req })
    .catch(() => null)

  const warnAt = Number((settings as { quotaWarnPercent?: unknown } | null)?.quotaWarnPercent ?? 80) / 100

  return { entitlement, report: buildQuotaReport(entitlement.limits, usage, { warnAt }), usage }
}

/**
 * The hot-path question: may this site create one more of `metric`?
 *
 * Returns `null` when the write is allowed and a Persian message when it is not, so
 * the caller's branch is `if (message) throw`. Ordering matters for cost: the
 * enforcement policy and the limit are both checked *before* any usage is counted,
 * so the overwhelmingly common case (no limit set, or warn-only mode) does no
 * database work beyond the entitlement read.
 */
export const quotaBlockMessage = async (
  req: PayloadRequest,
  siteId: string,
  metric: QuotaMetric,
): Promise<null | string> => {
  const site = await req.payload.findByID({
    id: siteId,
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })
  if (!site) return null

  const entitlement = await resolveEntitlement(req, site as unknown as Record<string, unknown>)
  if (entitlement.quotaEnforcement !== 'enforce') return null

  const limit = normalizeLimit(entitlement.limits[metric])
  if (limit === null) return null

  const usage = await usageForSite(req, siteId)
  const used = Number(usage[metric] ?? 0)
  if (used < limit) return null

  return `سقف «${metric}» در طرح «${entitlement.plan?.name ?? 'فعلی'}» تکمیل شده است (${used} از ${limit}). برای ادامه، طرح را ارتقا دهید.`
}
