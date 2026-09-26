import type { PayloadRequest } from 'payload'

import { limitsToQuota, quotaToLimits, type LimitMap } from '@/billing/entitlement/limits'
import { readProjection, writeProjection } from '@/billing/entitlement/store'
import { resolveLegacyEntitlement } from '@/platform/entitlements'

export type CommercialMigrationReport = {
  ambiguousSites: string[]
  entitlementOverrides: number
  invoicesByStatus: Record<string, number>
  ok: boolean
  plans: number
  sites: number
  sitesWithoutSubscription: number
  subscriptionsByStatus: Record<string, number>
}

const countWhere = async (
  req: PayloadRequest,
  collection: 'invoices' | 'plans' | 'sites' | 'subscriptions' | 'site-entitlements',
  where?: Record<string, unknown>,
): Promise<number> => {
  const { totalDocs } = await req.payload.count({
    collection,
    overrideAccess: true,
    req,
    ...(where ? { where: where as never } : {}),
  })
  return totalDocs
}

/**
 * Inventory of the legacy commercial tables. Refuses to claim success when a
 * site has more than one live subscription — that state has no single plan to
 * project.
 */
export const commercialMigrationReport = async (req: PayloadRequest): Promise<CommercialMigrationReport> => {
  const statuses = ['trialing', 'active', 'pastDue', 'suspended', 'cancelled', 'expired'] as const
  const invoiceStatuses = ['draft', 'issued', 'paid', 'void', 'uncollectible'] as const
  const subscriptionsByStatus: Record<string, number> = {}
  for (const status of statuses) {
    subscriptionsByStatus[status] = await countWhere(req, 'subscriptions', { status: { equals: status } })
  }
  const invoicesByStatus: Record<string, number> = {}
  for (const status of invoiceStatuses) {
    invoicesByStatus[status] = await countWhere(req, 'invoices', { status: { equals: status } })
  }

  const { docs: sites } = await req.payload.find({
    collection: 'sites',
    depth: 0,
    limit: 500,
    overrideAccess: true,
    pagination: false,
    req,
  })
  const ambiguousSites: string[] = []
  let sitesWithoutSubscription = 0
  for (const site of sites) {
    const { totalDocs } = await req.payload.count({
      collection: 'subscriptions',
      overrideAccess: true,
      req,
      where: {
        and: [
          { site: { equals: site.id } },
          { status: { in: ['trialing', 'active', 'pastDue', 'suspended'] } },
        ],
      },
    })
    if (totalDocs > 1) ambiguousSites.push(String(site.id))
    if (totalDocs === 0) sitesWithoutSubscription += 1
  }

  return {
    ambiguousSites,
    entitlementOverrides: await countWhere(req, 'site-entitlements'),
    invoicesByStatus,
    ok: ambiguousSites.length === 0,
    plans: await countWhere(req, 'plans'),
    sites: sites.length,
    sitesWithoutSubscription,
    subscriptionsByStatus,
  }
}

export type DualReadMismatch = {
  field: string
  key?: string
  legacy: string
  projected: string
  siteId: string
}

export const compareEntitlement = (
  siteId: string,
  legacy: { featureMap: Record<string, boolean>; limits: Record<string, null | number | undefined>; plan: null | { code: string }; serving: boolean },
  projection: null | { features?: unknown; limits?: unknown; planCode?: unknown; serving?: unknown },
): DualReadMismatch[] => {
  if (!projection) {
    return [{ field: 'projection', legacy: 'present', projected: 'missing', siteId }]
  }
  const mismatches: DualReadMismatch[] = []
  const projectedServing = projection.serving === true
  if (legacy.serving !== projectedServing) {
    mismatches.push({
      field: 'serving',
      legacy: String(legacy.serving),
      projected: String(projectedServing),
      siteId,
    })
  }
  const legacyCode = legacy.plan?.code ?? ''
  const projectedCode = typeof projection.planCode === 'string' ? projection.planCode : ''
  if (legacyCode !== projectedCode) {
    mismatches.push({ field: 'planCode', legacy: legacyCode, projected: projectedCode, siteId })
  }
  const features = projection.features && typeof projection.features === 'object' ? (projection.features as Record<string, boolean>) : {}
  const keys = new Set([...Object.keys(legacy.featureMap), ...Object.keys(features)])
  for (const key of keys) {
    const left = legacy.featureMap[key] === true
    const right = features[key] === true
    if (left !== right) mismatches.push({ field: 'feature', key, legacy: String(left), projected: String(right), siteId })
  }
  const limits = projection.limits && typeof projection.limits === 'object' ? (projection.limits as LimitMap) : {}
  const projectedQuota = limitsToQuota(limits)
  const metricKeys = new Set([...Object.keys(legacy.limits), ...Object.keys(projectedQuota)])
  for (const key of metricKeys) {
    const left = legacy.limits[key] ?? null
    const right = projectedQuota[key as keyof typeof projectedQuota] ?? null
    if (left !== right) {
      mismatches.push({ field: 'limit', key, legacy: String(left), projected: String(right), siteId })
    }
  }
  return mismatches
}

/**
 * Write version-1 projections from the legacy resolver. Skips sites that
 * already have a projection. Stops if any site has two live subscriptions.
 */
export const seedProjectionsFromLegacy = async (
  req: PayloadRequest,
): Promise<{ created: number; mismatches: DualReadMismatch[]; skipped: number }> => {
  const report = await commercialMigrationReport(req)
  if (!report.ok) {
    throw new Error(`ambiguous commercial state for sites: ${report.ambiguousSites.join(', ')}`)
  }
  const { docs: sites } = await req.payload.find({
    collection: 'sites',
    depth: 0,
    limit: 500,
    overrideAccess: true,
    pagination: false,
    req,
  })
  let created = 0
  let skipped = 0
  const mismatches: DualReadMismatch[] = []
  for (const site of sites) {
    const siteId = String(site.id)
    const existing = await readProjection(req, siteId)
    const legacy = await resolveLegacyEntitlement(req, site as unknown as Record<string, unknown>)
    if (existing) {
      skipped += 1
      mismatches.push(
        ...compareEntitlement(siteId, legacy, {
          features: existing.features,
          limits: existing.limits,
          planCode: existing.planCode,
          serving: existing.serving,
        }),
      )
      continue
    }
    await writeProjection(req, {
      billingCycleEnd: legacy.subscription?.currentPeriodEnd ?? null,
      billingCycleStart: null,
      features: legacy.featureMap,
      limits: quotaToLimits(legacy.limits),
      planCode: legacy.plan?.code ?? null,
      serving: legacy.serving,
      siteId,
      source: 'migration',
      subscriptionStatus: legacy.subscription?.status ?? null,
      version: 1,
    })
    created += 1
  }
  return { created, mismatches, skipped }
}
