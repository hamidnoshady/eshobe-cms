import type { PayloadRequest, Where } from 'payload'

import {
  accumulateOrderTotals,
  clampReportDays,
  currencyRows,
  ORDER_SCAN_CAP,
  tally,
  type CurrencyTotals,
} from '@/lib/platform-control'
import { getActiveConnection } from '@/storage/connection'
import { gatewayDescriptor, gatewayIds } from '@/payments/gateways/registry'
import { paymentsModuleState } from '@/payments/gateways/resolve'
import type { SiteDeploymentSummary } from '@/deploy/siteDeploymentSummary'
import { siteDeploymentSummaryFor } from '@/deploy/siteDeploymentSummary'

/**
 * The fleet report — "what is this whole CMS deployment doing?" — assembled for
 * the sibling POS console's «سایت‌ساز» section.
 *
 * The CMS admin answers every question one site at a time, because that is what
 * an editor needs. A platform operator's questions are the other shape: how many
 * sites are unverified, which gateway has never passed a self-test, is object
 * storage actually enabled, did the jobs queue stop. Each is a `count` away, and
 * none of them has a screen. This module is that list of counts, and
 * `src/endpoints/platformControl.ts` is its HTTP face.
 *
 * Every read is `overrideAccess: true` on purpose and it is the one thing to be
 * careful about here: the caller has already been proven to be a platform
 * operator (an admin session or a `role: "platform"` key), and a tenant-scoped
 * read would answer "one site" to a question that is about all of them. Nothing
 * in what is returned is a credential — the gateway rows are counted, never read
 * out, and the storage connection contributes a bucket name and a boolean.
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
    // A collection that does not exist yet (a database mid-migration) must not
    // take the whole report down: the console shows a report with a hole in it,
    // which is more useful than a 500 with nothing in it.
    req.payload.logger.error({ err: error as Error, msg: `platform report: count ${collection} failed` })
    return -1
  }
}

const published: Where = { _status: { equals: 'published' } }

export type PlatformOverview = Awaited<ReturnType<typeof platformOverview>>

/**
 * `days` bounds only the *money* and the event-shaped figures; document counts are
 * lifetime, because "how many products exist" has no window.
 */
export const platformOverview = async (
  req: PayloadRequest,
  opts: { days?: unknown } = {},
) => {
  const days = clampReportDays(opts.days)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const sites = await req.payload.find({
    collection: 'sites',
    depth: 0,
    limit: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: {
      createdAt: true,
      domain: true,
      domainVerified: true,
      name: true,
      status: true,
      type: true,
    },
  })

  const siteDocs = sites.docs as unknown as {
    createdAt?: string
    domainVerified?: boolean
    status?: string
    type?: string
  }[]

  const [
    pages,
    pagesPublished,
    posts,
    postsPublished,
    products,
    productsPublished,
    categories,
    media,
    orders,
    keysTotal,
    keysDisabled,
    users,
    cdnZones,
    aliasSites,
    gatewayRows,
  ] = await Promise.all([
    countOf(req, 'pages'),
    countOf(req, 'pages', published),
    countOf(req, 'posts'),
    countOf(req, 'posts', published),
    countOf(req, 'products'),
    countOf(req, 'products', published),
    countOf(req, 'categories'),
    countOf(req, 'media'),
    countOf(req, 'orders'),
    countOf(req, 'api-keys'),
    countOf(req, 'api-keys', { disabledAt: { exists: true } }),
    countOf(req, 'users'),
    countOf(req, 'cdn-zones'),
    countOf(req, 'sites', { 'domains.hostname': { exists: true } }),
    countOf(req, 'payment-gateways'),
  ])

  const orderStatuses = ['pending', 'paid', 'cancelled', 'refunded'] as const
  const orderCounts = Object.fromEntries(
    await Promise.all(
      orderStatuses.map(async (status) => [status, await countOf(req, 'orders', { status: { equals: status } })] as const),
    ),
  ) as Record<(typeof orderStatuses)[number], number>

  const revenue = await windowedRevenue(req, since)

  const moduleState = await paymentsModuleState(req)
  const gateways = await Promise.all(
    gatewayIds.map(async (gateway) => {
      const descriptor = gatewayDescriptor(gateway)
      // `selfTestOk` is a checkbox, so "never tested" and "tested and failed" are the
      // same `false` — `selfTestAt` is what separates them, and they are separate
      // tickets: one is a merchant who has not finished onboarding, the other is a
      // shop that will refuse payments today.
      const [rows, enabled, passing, failing] = await Promise.all([
        countOf(req, 'payment-gateways', { gateway: { equals: gateway } }),
        countOf(req, 'payment-gateways', {
          and: [{ gateway: { equals: gateway } }, { enabled: { equals: true } }],
        }),
        countOf(req, 'payment-gateways', {
          and: [{ gateway: { equals: gateway } }, { selfTestOk: { equals: true } }],
        }),
        countOf(req, 'payment-gateways', {
          and: [
            { gateway: { equals: gateway } },
            { selfTestAt: { exists: true } },
            { selfTestOk: { not_equals: true } },
          ],
        }),
      ])
      return {
        allowed: moduleState.allowed.includes(gateway),
        enabled,
        failingSelfTest: failing,
        gateway,
        label: descriptor.label,
        passingSelfTest: passing,
        rows,
      }
    }),
  )

  const storage = await storageState(req)
  const jobs = await jobsState(req)

  return {
    commerce: {
      byStatus: orderCounts,
      orders,
      revenue: currencyRows(revenue.totals),
      revenueTruncated: revenue.truncated,
      windowDays: days,
    },
    content: {
      categories,
      media,
      pages,
      pagesPublished,
      posts,
      postsPublished,
      products,
      productsPublished,
    },
    gateways: {
      moduleEnabled: moduleState.enabled,
      rows: gatewayRows,
      table: gateways,
    },
    generatedAt: new Date().toISOString(),
    infrastructure: {
      cdnZones,
      jobs,
      keys: { disabled: keysDisabled, total: keysTotal },
      sitesWithAliases: aliasSites,
      storage,
      users,
    },
    sites: {
      byStatus: tally(siteDocs.map((doc) => doc.status)),
      byType: tally(siteDocs.map((doc) => doc.type)),
      createdInWindow: siteDocs.filter((doc) => (doc.createdAt ?? '') >= since).length,
      total: siteDocs.length,
      unverified: siteDocs.filter((doc) => doc.domainVerified !== true).length,
      verified: siteDocs.filter((doc) => doc.domainVerified === true).length,
    },
  }
}

/**
 * Paid-order money for the window, per currency.
 *
 * Payload has no aggregate and this codebase keeps raw SQL to migrations, so the
 * sum is a paged scan — bounded by the window *and* by `ORDER_SCAN_CAP`, and
 * honest about it: `truncated: true` is what stops a capped scan from reading as
 * "that is all the revenue there was".
 */
const windowedRevenue = async (
  req: PayloadRequest,
  since: string,
): Promise<{ totals: CurrencyTotals; truncated: boolean }> => {
  const totals: CurrencyTotals = {}
  const pageSize = 500
  let page = 1
  let scanned = 0

  for (;;) {
    const result = await req.payload.find({
      collection: 'orders',
      depth: 0,
      limit: pageSize,
      overrideAccess: true,
      page,
      req,
      select: { currency: true, total: true },
      where: {
        and: [{ status: { equals: 'paid' } }, { updatedAt: { greater_than_equal: since } }],
      },
    })
    accumulateOrderTotals(result.docs as { currency?: unknown; total?: unknown }[], totals)
    scanned += result.docs.length
    if (!result.hasNextPage) return { totals, truncated: false }
    if (scanned >= ORDER_SCAN_CAP) return { totals, truncated: true }
    page += 1
  }
}

/**
 * Whether media is actually going to ArvanCloud, without ever touching the secret.
 *
 * `getActiveConnection` is the one reader of the encrypted key (WAVE-6); what comes
 * back here is the bucket, the endpoint and two booleans — enough for an operator
 * to tell "no connection" from "a connection nobody enabled" from "enabled but the
 * key no longer decrypts", which are three different tickets.
 */
const storageState = async (req: PayloadRequest) => {
  try {
    const connection = await getActiveConnection(req)
    if (!connection) {
      const rows = await countOf(req, 'storage-connections')
      return { bucket: null, enabled: false, endpoint: null, rows, usable: false }
    }
    return {
      bucket: connection.bucket,
      enabled: true,
      endpoint: connection.endpoint,
      rows: await countOf(req, 'storage-connections'),
      usable: true,
    }
  } catch (error) {
    // `getActiveConnection` throws for exactly one state: a connection IS enabled but
    // its secret is missing or no longer decrypts (a rotated OBJECT_STORAGE_KEY). That
    // is the state worth naming, so it is reported as enabled-but-unusable rather than
    // collapsed into "no storage" — the symptom otherwise reads as "somebody turned it
    // off", and nobody did.
    req.payload.logger.error({ err: error as Error, msg: 'platform report: storage state failed' })
    return {
      bucket: null,
      enabled: true,
      endpoint: null,
      rows: await countOf(req, 'storage-connections'),
      usable: false,
    }
  }
}

/**
 * The jobs queue, read the way `payload_jobs` is actually shaped: a job that has
 * been tried and has not completed is the interesting one, because CLAUDE.md's
 * failure mode ("a due `schedulePublish` sits with `total_tried: 0` and the
 * document never publishes, with no error anywhere") is invisible from every other
 * screen this deployment has.
 */
const jobsState = async (req: PayloadRequest) => {
  try {
    const [queued, failed, completed] = await Promise.all([
      req.payload.count({
        collection: 'payload-jobs',
        overrideAccess: true,
        req,
        where: { completedAt: { exists: false } },
      }),
      req.payload.count({
        collection: 'payload-jobs',
        overrideAccess: true,
        req,
        where: { and: [{ completedAt: { exists: false } }, { hasError: { equals: true } }] },
      }),
      req.payload.count({
        collection: 'payload-jobs',
        overrideAccess: true,
        req,
        where: { completedAt: { exists: true } },
      }),
    ])
    return {
      available: true,
      completed: completed.totalDocs,
      failed: failed.totalDocs,
      queued: queued.totalDocs,
    }
  } catch (error) {
    // The jobs collection is created by Payload itself and is absent on a database
    // that predates it; that is a fact about the deployment, not an error to raise.
    req.payload.logger.error({ err: error as Error, msg: 'platform report: jobs state failed' })
    return { available: false, completed: -1, failed: -1, queued: -1 }
  }
}

export type SiteReport = {
  aliases: { hostname: string; verified: boolean }[]
  deployment: SiteDeploymentSummary
  availableLocales: string[]
  createdAt: null | string
  currency: null | string
  defaultLocale: null | string
  domain: string
  domainVerified: boolean
  gateways: { enabled: boolean; gateway: string; selfTest: 'failed' | 'ok' | null }[]
  id: string
  name: string
  slug: null | string
  status: string
  totals: {
    categories: number
    media: number
    orders: number
    ordersPaid: number
    pages: number
    pagesPublished: number
    posts: number
    postsPublished: number
    products: number
    productsPublished: number
  }
  type: string
  updatedAt: null | string
}

const scoped = (siteId: string, extra?: Where): Where =>
  extra ? { and: [{ site: { equals: siteId } }, extra] } : { site: { equals: siteId } }

/** One site's row in the console's table — the same shape whether it came from the list or the detail call. */
export const siteReportFor = async (
  req: PayloadRequest,
  site: Record<string, unknown>,
): Promise<SiteReport> => {
  const id = String(site.id)
  const [
    pages,
    pagesPublished,
    posts,
    postsPublished,
    products,
    productsPublished,
    categories,
    media,
    orders,
    ordersPaid,
  ] = await Promise.all([
    countOf(req, 'pages', scoped(id)),
    countOf(req, 'pages', scoped(id, published)),
    countOf(req, 'posts', scoped(id)),
    countOf(req, 'posts', scoped(id, published)),
    countOf(req, 'products', scoped(id)),
    countOf(req, 'products', scoped(id, published)),
    countOf(req, 'categories', scoped(id)),
    countOf(req, 'media', scoped(id)),
    countOf(req, 'orders', scoped(id)),
    countOf(req, 'orders', scoped(id, { status: { equals: 'paid' } })),
  ])

  const storeDocs = await req.payload.find({
    collection: 'store',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    select: { currency: true },
    where: { site: { equals: id } },
  })

  const gatewayDocs = await req.payload.find({
    collection: 'payment-gateways',
    depth: 0,
    limit: 50,
    overrideAccess: true,
    req,
    select: { enabled: true, gateway: true, selfTestAt: true, selfTestOk: true },
    where: { site: { equals: id } },
  })

  const aliases = Array.isArray(site.domains)
    ? (site.domains as { hostname?: unknown; verified?: unknown }[]).map((row) => ({
        hostname: String(row?.hostname ?? ''),
        verified: row?.verified === true,
      }))
    : []

  const deployment = await siteDeploymentSummaryFor(req, site)

  return {
    aliases,
    availableLocales: Array.isArray(site.availableLocales)
      ? (site.availableLocales as unknown[]).map(String)
      : [],
    createdAt: typeof site.createdAt === 'string' ? site.createdAt : null,
    currency:
      typeof (storeDocs.docs[0] as { currency?: unknown } | undefined)?.currency === 'string'
        ? String((storeDocs.docs[0] as { currency?: unknown }).currency)
        : null,
    defaultLocale: typeof site.defaultLocale === 'string' ? site.defaultLocale : null,
    deployment,
    domain: String(site.domain ?? ''),
    domainVerified: site.domainVerified === true,
    gateways: (
      gatewayDocs.docs as { enabled?: unknown; gateway?: unknown; selfTestAt?: unknown; selfTestOk?: unknown }[]
    ).map((row) => ({
      enabled: row.enabled === true,
      gateway: String(row.gateway ?? ''),
      selfTest: row.selfTestAt ? (row.selfTestOk === true ? 'ok' : 'failed') : null,
    })),
    id,
    name: String(site.name ?? ''),
    slug: typeof site.slug === 'string' ? site.slug : null,
    status: String(site.status ?? 'active'),
    totals: {
      categories,
      media,
      orders,
      ordersPaid,
      pages,
      pagesPublished,
      posts,
      postsPublished,
      products,
      productsPublished,
    },
    type: String(site.type ?? 'business'),
    updatedAt: typeof site.updatedAt === 'string' ? site.updatedAt : null,
  }
}
