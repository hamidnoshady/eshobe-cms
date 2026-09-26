import type { PayloadRequest, Where } from 'payload'

import { clampReportDays } from '@/lib/platform-control'
import { billingIntegrationHealth } from '@/billing/health'
import { isUuid } from '@/lib/ids'
import { slugKey } from '@/lib/saas/plans'

/**
 * Operator overview for the website execution plane.
 *
 * Commercial revenue, invoices and subscription counts are not computed here.
 * cafe-restaurant-pos is the billing authority. This report answers whether the
 * CMS is enforcing the cached entitlement and whether usage is leaving the outbox.
 */

const countOf = async (
  req: PayloadRequest,
  collection: Parameters<PayloadRequest['payload']['count']>[0]['collection'],
  where?: Where,
): Promise<number> => {
  try {
    const { totalDocs } = await req.payload.count({
      collection,
      overrideAccess: true,
      req,
      ...(where ? { where } : {}),
    })
    return totalDocs
  } catch (error) {
    // A collection missing on a database mid-migration must leave a hole in the
    // report, never take the whole report down — the same choice `report.ts` makes.
    req.payload.logger.error({ err: error as Error, msg: `saas report: count ${collection} failed` })
    return -1
  }
}

export type SaasOverview = Awaited<ReturnType<typeof saasOverview>>

export const saasOverview = async (req: PayloadRequest, opts: { days?: unknown } = {}) => {
  const days = clampReportDays(opts.days)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const [
    billing,
    pluginsTotal,
    pluginsEnabled,
    themesTotal,
    webhooksTotal,
    webhooksEnabled,
    webhooksFailing,
    featuresTotal,
    auditRecent,
    settings,
  ] = await Promise.all([
    billingIntegrationHealth(req),
    countOf(req, 'plugins'),
    countOf(req, 'plugins', { enabled: { equals: true } }),
    countOf(req, 'theme-templates', { active: { equals: true } }),
    countOf(req, 'webhooks'),
    countOf(req, 'webhooks', { enabled: { equals: true } }),
    countOf(req, 'webhooks', { consecutiveFailures: { greater_than: 0 } }),
    countOf(req, 'feature-flags'),
    countOf(req, 'audit-log', { createdAt: { greater_than: since } }),
    req.payload.findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req }).catch(() => null),
  ])

  return {
    billing,
    commercialAuthority: 'cafe-restaurant-pos' as const,
    extensions: {
      featureFlags: featuresTotal,
      plugins: { enabled: pluginsEnabled, total: pluginsTotal },
      themes: themesTotal,
    },
    generatedAt: new Date().toISOString(),
    operations: {
      auditEntriesInWindow: auditRecent,
      maintenanceMode: (settings as { maintenanceMode?: unknown } | null)?.maintenanceMode === true,
      quotaEnforcement: String((settings as { quotaEnforcement?: unknown } | null)?.quotaEnforcement ?? 'warn'),
      signupsOpen: (settings as { signupsOpen?: unknown } | null)?.signupsOpen === true,
      webhooks: { enabled: webhooksEnabled, failing: webhooksFailing, total: webhooksTotal },
    },
    windowDays: days,
  }
}

/**
 * Which plugins apply to one site — global ones plus the ones that name it.
 *
 * Credentials are never in the answer. What a caller gets is the key, the type and
 * the non-secret `settings`, which is exactly what a renderer needs to decide
 * "inject this analytics snippet" and nothing more.
 */
export const pluginsForSite = async (
  req: PayloadRequest,
  siteId: string,
): Promise<{ key: string; settings: unknown; type: string; version: null | string }[]> => {
  const { docs } = await req.payload.find({
    collection: 'plugins',
    depth: 0,
    limit: 200,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [
        { enabled: { equals: true } },
        { or: [{ scope: { equals: 'global' } }, { sites: { contains: siteId } }] },
      ],
    },
  })

  return (docs as unknown as Record<string, unknown>[]).map((doc) => ({
    key: String(doc.key ?? ''),
    settings: doc.settings ?? {},
    type: String(doc.type ?? 'custom'),
    version: typeof doc.version === 'string' ? doc.version : null,
  }))
}

/**
 * Copy a template's tokens onto a site's `theme` document.
 *
 * Only the keys the live `theme` collection actually has are copied — a template
 * holding a token this deployment's theme has not grown yet must not fail the
 * apply, and a token the template is missing must not blank the site's current
 * value. That is why this is an explicit field list and not a spread.
 */
export const applyThemeTemplate = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
  reference: string,
): Promise<{ id?: string; message?: string; ok: boolean; theme?: string }> => {
  const ref = String(reference ?? '').trim()
  if (!ref) return { message: 'پوسته‌ای انتخاب نشده است.', ok: false }

  const template = isUuid(ref)
    ? await req.payload.findByID({
        id: ref,
        collection: 'theme-templates',
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
        req,
      })
    : (
        await req.payload.find({
          collection: 'theme-templates',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          req,
          where: { key: { equals: slugKey(ref) } },
        })
      ).docs[0]

  if (!template) return { message: `پوستهٔ «${ref}» پیدا نشد.`, ok: false }

  const tokens = (template as { tokens?: Record<string, unknown> }).tokens ?? {}
  const data: Record<string, unknown> = {}
  for (const key of ['accent', 'background', 'foreground', 'lineHeight', 'primary', 'radius'] as const) {
    if (tokens[key] !== undefined && tokens[key] !== null && tokens[key] !== '') data[key] = tokens[key]
  }

  const { docs } = await req.payload.find({
    collection: 'theme',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { site: { equals: String(site.id) } },
  })

  const existing = docs[0]

  const doc = existing
    ? await req.payload.update({
        id: String(existing.id),
        collection: 'theme',
        data,
        depth: 0,
        overrideAccess: true,
        req,
      })
    : await req.payload.create({
        collection: 'theme',
        data: { ...data, site: String(site.id) },
        depth: 0,
        overrideAccess: true,
        req,
      })

  return { id: String(doc.id), ok: true, theme: String((template as { key?: unknown }).key ?? ref) }
}
