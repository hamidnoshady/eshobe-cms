import type { PayloadRequest, Where } from 'payload'

import {
  accumulateOrderTotals,
  clampReportDays,
  currencyRows,
  type CurrencyTotals,
} from '@/lib/platform-control'
import { isUuid } from '@/lib/ids'
import { slugKey } from '@/lib/saas/plans'

/**
 * The commercial report — "is this SaaS healthy as a business?"
 *
 * `src/platform/report.ts` answers the *operational* version of that question
 * (sites, content, storage, jobs). This one answers the commercial one: who is on
 * which plan, how much was invoiced and collected, what is overdue, how many
 * subscriptions are in trial and how many are about to lapse.
 *
 * Same two rules as the operational report, restated because they are what keeps a
 * dashboard from becoming an outage:
 *
 *  - **No unbounded scan.** Counts come from `payload.count`. Money is summed row by
 *    row (Payload has no aggregate; raw SQL stays in migrations), so every sum is
 *    both windowed and capped, and says so when it was cut short.
 *  - **Sums are per currency, in minor units.** An invoice snapshots the currency it
 *    was issued in, so adding two together invents a number.
 */

const INVOICE_SCAN_CAP = 5_000

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

/** Paged, capped sum of invoice totals per currency. */
const sumInvoices = async (
  req: PayloadRequest,
  where: Where,
): Promise<{ count: number; totals: CurrencyTotals; truncated: boolean }> => {
  const totals: CurrencyTotals = {}
  let page = 1
  let scanned = 0

  for (;;) {
    const result = await req.payload
      .find({
        collection: 'invoices',
        depth: 0,
        limit: 500,
        overrideAccess: true,
        page,
        req,
        select: { currency: true, total: true },
        where,
      })
      .catch(() => null)

    if (!result) return { count: scanned, totals, truncated: false }

    // `accumulateOrderTotals` is the same per-currency bucket the fleet report uses
    // for orders — reused rather than re-implemented so "minor units, never summed
    // across currencies" has one implementation and one test.
    accumulateOrderTotals(result.docs as { currency?: unknown; total?: unknown }[], totals)

    scanned += result.docs.length
    if (!result.hasNextPage) return { count: scanned, totals, truncated: false }
    if (scanned >= INVOICE_SCAN_CAP) return { count: scanned, totals, truncated: true }
    page += 1
  }
}

export type SaasOverview = Awaited<ReturnType<typeof saasOverview>>

export const saasOverview = async (req: PayloadRequest, opts: { days?: unknown } = {}) => {
  const days = clampReportDays(opts.days)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const nowIso = new Date().toISOString()
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const [
    plansTotal,
    plansActive,
    subsTotal,
    subsTrialing,
    subsActive,
    subsPastDue,
    subsSuspended,
    subsCancelled,
    subsExpiringSoon,
    invoicesTotal,
    invoicesDraft,
    invoicesIssued,
    invoicesOverdue,
    pluginsTotal,
    pluginsEnabled,
    themesTotal,
    webhooksTotal,
    webhooksEnabled,
    webhooksFailing,
    featuresTotal,
    auditRecent,
  ] = await Promise.all([
    countOf(req, 'plans'),
    countOf(req, 'plans', { active: { equals: true } }),
    countOf(req, 'subscriptions'),
    countOf(req, 'subscriptions', { status: { equals: 'trialing' } }),
    countOf(req, 'subscriptions', { status: { equals: 'active' } }),
    countOf(req, 'subscriptions', { status: { equals: 'pastDue' } }),
    countOf(req, 'subscriptions', { status: { equals: 'suspended' } }),
    countOf(req, 'subscriptions', { status: { equals: 'cancelled' } }),
    countOf(req, 'subscriptions', {
      and: [
        { entitled: { equals: true } },
        { currentPeriodEnd: { greater_than: nowIso } },
        { currentPeriodEnd: { less_than: soon } },
      ],
    }),
    countOf(req, 'invoices'),
    countOf(req, 'invoices', { status: { equals: 'draft' } }),
    countOf(req, 'invoices', { status: { equals: 'issued' } }),
    countOf(req, 'invoices', {
      and: [{ status: { equals: 'issued' } }, { dueAt: { less_than: nowIso } }],
    }),
    countOf(req, 'plugins'),
    countOf(req, 'plugins', { enabled: { equals: true } }),
    countOf(req, 'theme-templates', { active: { equals: true } }),
    countOf(req, 'webhooks'),
    countOf(req, 'webhooks', { enabled: { equals: true } }),
    countOf(req, 'webhooks', { consecutiveFailures: { greater_than: 0 } }),
    countOf(req, 'feature-flags'),
    countOf(req, 'audit-log', { createdAt: { greater_than: since } }),
  ])

  const [collected, billed, outstanding] = await Promise.all([
    sumInvoices(req, {
      and: [{ status: { equals: 'paid' } }, { paidAt: { greater_than_equal: since } }],
    }),
    sumInvoices(req, {
      and: [
        { status: { not_equals: 'void' } },
        { status: { not_equals: 'draft' } },
        { createdAt: { greater_than_equal: since } },
      ],
    }),
    sumInvoices(req, { status: { equals: 'issued' } }),
  ])

  // Plan distribution: one count per plan, not a scan of the subscriptions table.
  const { docs: planDocs } = await req.payload
    .find({
      collection: 'plans',
      depth: 0,
      limit: 100,
      overrideAccess: true,
      pagination: false,
      req,
      select: { code: true, currency: true, interval: true, name: true, price: true },
      sort: 'sortOrder',
    })
    .catch(() => ({ docs: [] as Record<string, unknown>[] }))

  const byPlan = []
  for (const plan of planDocs as unknown as Record<string, unknown>[]) {
    byPlan.push({
      code: String(plan.code ?? ''),
      currency: String(plan.currency ?? 'IRT'),
      id: String(plan.id),
      interval: String(plan.interval ?? 'monthly'),
      name: String(plan.name ?? ''),
      price: Number(plan.price ?? 0),
      subscribers: await countOf(req, 'subscriptions', {
        and: [{ plan: { equals: plan.id } }, { entitled: { equals: true } }],
      }),
    })
  }

  const settings = await req.payload
    .findGlobal({ slug: 'platform-settings', depth: 0, overrideAccess: true, req })
    .catch(() => null)

  return {
    billing: {
      billed: currencyRows(billed.totals),
      collected: currencyRows(collected.totals),
      invoices: {
        draft: invoicesDraft,
        issued: invoicesIssued,
        overdue: invoicesOverdue,
        total: invoicesTotal,
      },
      outstanding: currencyRows(outstanding.totals),
      truncated: billed.truncated || collected.truncated || outstanding.truncated,
      windowDays: days,
    },
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
    plans: { active: plansActive, byPlan, total: plansTotal },
    subscriptions: {
      active: subsActive,
      cancelled: subsCancelled,
      expiringWithin7Days: subsExpiringSoon,
      pastDue: subsPastDue,
      suspended: subsSuspended,
      total: subsTotal,
      trialing: subsTrialing,
    },
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
