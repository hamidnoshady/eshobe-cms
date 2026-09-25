import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isUuid } from '@/lib/ids'
import { clampLimit, clampPage } from '@/lib/platform-control'
import { clampInt, isQuotaMetric, QUOTA_METRICS, slugKey, type QuotaMetric } from '@/lib/saas/plans'
import { PLATFORM_EVENT_NAMES, isPlatformEvent } from '@/lib/saas/events'
import { quotaReportForSite, resolveEntitlement, subscriptionForSite, usageForSite } from '@/platform/entitlements'
import { emitPlatformEvent } from '@/platform/webhooks'
import { recordUsage } from '@/platform/usage'
import { applyThemeTemplate, pluginsForSite, saasOverview } from '@/platform/saas-report'

import { json, param, requireOperator, search, siteById } from './platformShared'

/**
 * `/api/platform/*` — the SaaS half of the control surface.
 *
 * `src/endpoints/platformControl.ts` is the fleet: sites, reports, events,
 * snapshots. This file is everything that makes the deployment a *product* —
 * plans, subscriptions, invoices, entitlements, quotas, plugins, themes, webhooks,
 * feature flags, the audit trail and the operator's settings — and it is
 * deliberately in the same `/api/platform/*` namespace and behind the same guard,
 * because an external console holding one credential should not have to learn two.
 *
 * ## Who may call it
 *
 * A platform-admin session or a `role: "platform"` API key, exactly as the fleet
 * routes do (`isPlatformAdminOrPlatformKey`). A `role: "site"` key reaches none of
 * it: a site key is a customer's integration credential, and a customer changing
 * their own plan or reading the price list is not an API call, it is a purchase.
 *
 * The one exception is `GET /api/platform/self/entitlement`, which answers *for the
 * site the caller's own key belongs to* and returns features and quota state only —
 * no prices, no plan internals, no other site. That route exists because the
 * alternative is every customer app hard-coding which features it thinks it has.
 *
 * ## Why no Caddy carve-out
 *
 * Same reason as the fleet routes: `/api*` on a customer domain is a 404 by design
 * (`@control_plane_paths`), and these are called with the control plane's own
 * `Host`. Routing them onto customer domains would put the platform's price list
 * and audit trail one `curl` away from anybody on a shop's homepage.
 *
 * ## Ordering
 *
 * Payload matches endpoints in array order, so every literal path is registered
 * before any `:id` pattern that could swallow it. `/platform/sites/:id/quota` must
 * come before `/platform/sites/:id` — the fleet file records the same trap.
 */

/** Session-only: a key must not be able to mutate the platform's own commercial records. */
const requireAdminSession = (req: PayloadRequest): null | Response => {
  if (isPlatformAdmin(req.user)) return null
  return json({ message: 'این عملیات فقط با نشست مدیر پلتفرم انجام می‌شود.', ok: false }, 403)
}

const readBody = async (req: PayloadRequest): Promise<{ body?: Record<string, unknown>; error?: Response }> => {
  try {
    const parsed = (await req.json?.()) ?? {}
    if (!parsed || typeof parsed !== 'object') {
      return { error: json({ message: 'بدنهٔ درخواست باید یک شیء JSON باشد.', ok: false }, 400) }
    }
    return { body: parsed as Record<string, unknown> }
  } catch {
    return { error: json({ message: 'بدنهٔ درخواست باید JSON باشد.', ok: false }, 400) }
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** `GET /api/platform/saas/overview` — the commercial front page: plans, subscriptions, revenue, quota pressure. */
export const saasOverviewEndpoint: Endpoint = {
  path: '/platform/saas/overview',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    return json({ ok: true, overview: await saasOverview(req, { days: params.get('days') }) })
  },
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** `GET /api/platform/plans` — the price list, with how many sites are on each plan. */
export const plansListEndpoint: Endpoint = {
  path: '/platform/plans',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const activeOnly = params.get('active') === 'true'

    const { docs } = await req.payload.find({
      collection: 'plans',
      depth: 1,
      limit: 200,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'sortOrder',
      ...(activeOnly ? { where: { active: { equals: true } } } : {}),
    })

    const plans = []
    for (const doc of docs as unknown as Record<string, unknown>[]) {
      const { totalDocs } = await req.payload.count({
        collection: 'subscriptions',
        overrideAccess: true,
        req,
        where: { and: [{ plan: { equals: doc.id } }, { entitled: { equals: true } }] },
      })
      plans.push({
        active: doc.active === true,
        code: String(doc.code ?? ''),
        currency: String(doc.currency ?? 'IRT'),
        description: doc.description ?? null,
        features: Array.isArray(doc.features)
          ? (doc.features as Record<string, unknown>[]).map((feature) =>
              typeof feature === 'string' ? feature : String(feature?.key ?? ''),
            )
          : [],
        id: String(doc.id),
        interval: String(doc.interval ?? 'monthly'),
        limits: doc.limits ?? {},
        name: String(doc.name ?? ''),
        price: Number(doc.price ?? 0),
        public: doc.public === true,
        sortOrder: Number(doc.sortOrder ?? 100),
        subscribers: totalDocs,
        trialDays: Number(doc.trialDays ?? 0),
      })
    }

    return json({ ok: true, plans, totalDocs: plans.length })
  },
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** `GET /api/platform/subscriptions?status=&plan=&limit=&page=` */
export const subscriptionsListEndpoint: Endpoint = {
  path: '/platform/subscriptions',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const status = params.get('status')
    const plan = params.get('plan')

    const result = await req.payload.find({
      collection: 'subscriptions',
      depth: 1,
      limit: clampLimit(params.get('limit'), 25, 100),
      overrideAccess: true,
      page: clampPage(params.get('page')),
      req,
      sort: '-createdAt',
      where: {
        and: [
          ...(status && status !== 'all' ? [{ status: { equals: status } }] : []),
          ...(plan && isUuid(plan) ? [{ plan: { equals: plan } }] : []),
        ],
      },
    })

    return json({
      ok: true,
      page: result.page ?? 1,
      subscriptions: (result.docs as unknown as Record<string, unknown>[]).map(subscriptionRow),
      totalDocs: result.totalDocs,
      totalPages: result.totalPages,
    })
  },
}

const subscriptionRow = (doc: Record<string, unknown>) => {
  const plan = doc.plan as Record<string, unknown> | string | null
  const site = doc.site as Record<string, unknown> | string | null
  return {
    autoRenew: doc.autoRenew === true,
    cancelledAt: doc.cancelledAt ?? null,
    currentPeriodEnd: doc.currentPeriodEnd ?? null,
    currentPeriodStart: doc.currentPeriodStart ?? null,
    entitled: doc.entitled === true,
    id: String(doc.id),
    plan:
      plan && typeof plan === 'object'
        ? { code: String(plan.code ?? ''), id: String(plan.id ?? ''), name: String(plan.name ?? '') }
        : { code: '', id: String(plan ?? ''), name: '' },
    site:
      site && typeof site === 'object'
        ? { domain: String(site.domain ?? ''), id: String(site.id ?? ''), name: String(site.name ?? '') }
        : { domain: '', id: String(site ?? ''), name: '' },
    startedAt: doc.startedAt ?? null,
    status: String(doc.status ?? ''),
    trialEndsAt: doc.trialEndsAt ?? null,
  }
}

/**
 * `POST /api/platform/subscriptions` — put a site on a plan (or move it).
 *
 * Idempotent by design: a site that already has a live subscription has that row
 * *updated* rather than a second one created, because `oneSubscriptionPerSite`
 * would refuse the create and a console that has to catch that error to do the
 * obvious thing is a console that will get it wrong.
 */
export const subscriptionUpsertEndpoint: Endpoint = {
  path: '/platform/subscriptions',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const { body, error } = await readBody(req)
    if (error) return error

    const siteId = String(body?.siteId ?? '')
    const planRef = String(body?.plan ?? body?.planId ?? '')
    if (!isUuid(siteId)) return json({ message: 'siteId معتبر نیست.', ok: false }, 400)

    const site = await siteById(req, siteId)
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    // A plan may be named by uuid or by its stable `code` — an external app should
    // not have to resolve uuids to say "put them on pro".
    const plan = ((isUuid(planRef)
      ? await req.payload.findByID({ id: planRef, collection: 'plans', depth: 0, disableErrors: true, overrideAccess: true, req })
      : (
          await req.payload.find({
            collection: 'plans',
            depth: 0,
            limit: 1,
            overrideAccess: true,
            req,
            where: { code: { equals: slugKey(planRef) } },
          })
        ).docs[0]) ?? null) as null | Record<string, unknown>

    if (!plan) return json({ message: 'طرح پیدا نشد.', ok: false }, 404)

    const existing = await subscriptionForSite(req, siteId)
    const data: Record<string, unknown> = {
      plan: String(plan.id),
      site: siteId,
      ...(typeof body?.status === 'string' ? { status: body.status } : {}),
      ...(typeof body?.autoRenew === 'boolean' ? { autoRenew: body.autoRenew } : {}),
      ...(body?.limitOverrides && typeof body.limitOverrides === 'object'
        ? { limitOverrides: body.limitOverrides }
        : {}),
      ...(typeof body?.notes === 'string' ? { notes: body.notes.slice(0, 2000) } : {}),
    }

    try {
      const doc = existing
        ? await req.payload.update({
            id: String(existing.id),
            collection: 'subscriptions',
            data: data as never,
            depth: 1,
            overrideAccess: true,
            req,
          })
        : await req.payload.create({
            collection: 'subscriptions',
            // The Local API's create type demands every required column; `data` is
            // built field by field above and the collection's own hooks supply the
            // derived ones (`reference`, the period, `entitled`), which the static
            // type cannot know.
            data: data as never,
            depth: 1,
            overrideAccess: true,
            req,
          })

      await emitPlatformEvent(req, {
        data: { plan: String(plan.code ?? plan.name ?? ''), status: String(doc.status ?? '') },
        event: existing ? 'subscription.changed' : 'subscription.created',
        message: `اشتراک ${site.domain} روی طرح «${plan.name}» ${existing ? 'تغییر کرد' : 'ساخته شد'}.`,
        site,
        targetCollection: 'subscriptions',
        targetId: String(doc.id),
      })

      return json({ ok: true, subscription: subscriptionRow(doc as unknown as Record<string, unknown>) }, existing ? 200 : 201)
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

/** `PATCH /api/platform/subscriptions/:id` — status, auto-renew, overrides. */
export const subscriptionPatchEndpoint: Endpoint = {
  path: '/platform/subscriptions/:id',
  method: 'patch',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const id = param(req, 'id')
    if (!isUuid(id)) return json({ message: 'شناسه معتبر نیست.', ok: false }, 400)

    const { body, error } = await readBody(req)
    if (error) return error

    const data: Record<string, unknown> = {}
    if (typeof body?.status === 'string') data.status = body.status
    if (typeof body?.autoRenew === 'boolean') data.autoRenew = body.autoRenew
    if (body?.limitOverrides && typeof body.limitOverrides === 'object') data.limitOverrides = body.limitOverrides
    if (typeof body?.notes === 'string') data.notes = body.notes.slice(0, 2000)

    if (!Object.keys(data).length) return json({ message: 'چیزی برای تغییر ارسال نشده است.', ok: false }, 400)

    try {
      const doc = await req.payload.update({
        id,
        collection: 'subscriptions',
        data,
        depth: 1,
        overrideAccess: true,
        req,
      })

      const row = subscriptionRow(doc as unknown as Record<string, unknown>)
      await emitPlatformEvent(req, {
        data: { status: row.status },
        event: row.status === 'cancelled' ? 'subscription.cancelled' : 'subscription.changed',
        message: `اشتراک ${row.site.domain} به وضعیت «${row.status}» رفت.`,
        site: row.site.id,
        targetCollection: 'subscriptions',
        targetId: id,
      })

      return json({ ok: true, subscription: row })
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

// ---------------------------------------------------------------------------
// Entitlement and quota
// ---------------------------------------------------------------------------

/** `GET /api/platform/sites/:id/entitlement` — plan, features and their source, for one site. */
export const siteEntitlementEndpoint: Endpoint = {
  path: '/platform/sites/:id/entitlement',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)
    return json({ entitlement: await resolveEntitlement(req, site), ok: true })
  },
}

/** `GET /api/platform/sites/:id/quota` — usage against limits, per metric. */
export const siteQuotaEndpoint: Endpoint = {
  path: '/platform/sites/:id/quota',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { entitlement, report, usage } = await quotaReportForSite(req, site)

    return json({
      enforcement: entitlement.quotaEnforcement,
      exceeded: report.exceeded,
      lines: report.lines,
      ok: true,
      over: report.over,
      plan: entitlement.plan,
      site: entitlement.site,
      usage,
      warning: report.warning,
    })
  },
}

/**
 * `POST /api/platform/sites/:id/usage` — report metered usage from an external app.
 *
 * The platform cannot count what happens outside it. A separately deployed renderer
 * serving a customer's site knows how many API requests it made; this CMS does not.
 * So the counter is writable — by an operator credential only, never by the site key
 * whose usage it records, because a client that can write its own meter has no meter.
 */
export const siteUsageEndpoint: Endpoint = {
  path: '/platform/sites/:id/usage',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const metric = String(body?.metric ?? '')
    if (!isQuotaMetric(metric)) {
      return json({ message: `سنجهٔ ناشناخته. مقادیر مجاز: ${QUOTA_METRICS.join(', ')}`, ok: false }, 400)
    }

    const amount = clampInt(body?.amount, 1, 1, 100_000)
    await recordUsage(req, { amount, metric: metric as QuotaMetric, siteId: String(site.id) })

    return json({ metric, ok: true, usage: await usageForSite(req, String(site.id)) })
  },
}

/**
 * `GET /api/platform/self/entitlement` — what *this* caller's site has.
 *
 * The one route in this file a site key may call, and the shape is narrowed to
 * match: features and quota state for that one site, no prices, no plan internals,
 * no other tenant. A customer app asking "may I show the checkout button?" should
 * not have to be told the platform's price list to find out.
 */
export const selfEntitlementEndpoint: Endpoint = {
  path: '/platform/self/entitlement',
  method: 'get',
  handler: async (req) => {
    const { requestApiKey } = await import('@/access/siteApiKey')
    const key = await requestApiKey(req)

    if (key?.role !== 'site' || !key.siteId) {
      return json({ message: 'این بخش با کلید سایت فراخوانی می‌شود.', ok: false }, 403)
    }

    const site = await siteById(req, key.siteId)
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { entitlement, report } = await quotaReportForSite(req, site)

    return json({
      features: entitlement.featureMap,
      ok: true,
      quota: {
        // Deliberately only the shape a client can act on: which metrics are at
        // their limit. Exact counts of another customer's scale are not the point,
        // and this is the one response a customer's own app reads.
        exceeded: report.exceeded,
        over: report.over,
        warning: report.warning,
      },
      serving: entitlement.serving,
      site: { domain: entitlement.site.domain, id: entitlement.site.id },
    })
  },
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/** `GET /api/platform/invoices?status=&site=&limit=&page=` */
export const invoicesListEndpoint: Endpoint = {
  path: '/platform/invoices',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const status = params.get('status')
    const site = params.get('site')

    const result = await req.payload.find({
      collection: 'invoices',
      depth: 1,
      limit: clampLimit(params.get('limit'), 25, 100),
      overrideAccess: true,
      page: clampPage(params.get('page')),
      req,
      sort: '-createdAt',
      where: {
        and: [
          ...(status && status !== 'all' ? [{ status: { equals: status } }] : []),
          ...(site && isUuid(site) ? [{ site: { equals: site } }] : []),
        ],
      },
    })

    return json({
      invoices: (result.docs as unknown as Record<string, unknown>[]).map(invoiceRow),
      ok: true,
      page: result.page ?? 1,
      totalDocs: result.totalDocs,
      totalPages: result.totalPages,
    })
  },
}

const invoiceRow = (doc: Record<string, unknown>) => {
  const site = doc.site as Record<string, unknown> | string | null
  return {
    currency: String(doc.currency ?? 'IRT'),
    discount: Number(doc.discount ?? 0),
    dueAt: doc.dueAt ?? null,
    id: String(doc.id),
    issuedAt: doc.issuedAt ?? null,
    lines: Array.isArray(doc.lines) ? doc.lines : [],
    number: String(doc.number ?? ''),
    paidAt: doc.paidAt ?? null,
    site:
      site && typeof site === 'object'
        ? { domain: String(site.domain ?? ''), id: String(site.id ?? '') }
        : { domain: '', id: String(site ?? '') },
    status: String(doc.status ?? 'draft'),
    subtotal: Number(doc.subtotal ?? 0),
    tax: Number(doc.tax ?? 0),
    total: Number(doc.total ?? 0),
  }
}

/** `POST /api/platform/invoices` — issue one. Totals are computed by the collection, never accepted here. */
export const invoiceCreateEndpoint: Endpoint = {
  path: '/platform/invoices',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const { body, error } = await readBody(req)
    if (error) return error

    const siteId = String(body?.siteId ?? '')
    if (!isUuid(siteId)) return json({ message: 'siteId معتبر نیست.', ok: false }, 400)
    const site = await siteById(req, siteId)
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const lines = Array.isArray(body?.lines) ? body.lines : []
    if (!lines.length) return json({ message: 'صورتحساب باید حداقل یک ردیف داشته باشد.', ok: false }, 400)

    try {
      const doc = await req.payload.create({
        collection: 'invoices',
        data: {
          currency: (typeof body?.currency === 'string' ? body.currency : 'IRT') as 'EUR' | 'IRR' | 'IRT' | 'USD',
          discount: Number(body?.discount ?? 0),
          dueAt: typeof body?.dueAt === 'string' ? body.dueAt : undefined,
          issuedAt: typeof body?.issuedAt === 'string' ? body.issuedAt : new Date().toISOString(),
          lines: (lines as Record<string, unknown>[]).map((line) => ({
            description: String(line?.description ?? '').slice(0, 500),
            quantity: Number(line?.quantity ?? 1),
            unitAmount: Number(line?.unitAmount ?? 0),
          })),
          notes: typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : undefined,
          site: siteId,
          status: (typeof body?.status === 'string' ? body.status : 'issued') as
            | 'draft'
            | 'issued'
            | 'paid'
            | 'uncollectible'
            | 'void',
          subscription: isUuid(String(body?.subscriptionId ?? '')) ? String(body?.subscriptionId) : undefined,
          taxPercent: Number(body?.taxPercent ?? 0),
        },
        depth: 1,
        overrideAccess: true,
        req,
      })

      const row = invoiceRow(doc as unknown as Record<string, unknown>)
      await emitPlatformEvent(req, {
        data: { number: row.number, total: row.total },
        event: 'invoice.issued',
        message: `صورتحساب ${row.number} برای ${site.domain} صادر شد.`,
        site,
        targetCollection: 'invoices',
        targetId: row.id,
      })

      return json({ invoice: row, ok: true }, 201)
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

/** `POST /api/platform/invoices/:id/pay` — record a payment against an invoice. */
export const invoicePayEndpoint: Endpoint = {
  path: '/platform/invoices/:id/pay',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const id = param(req, 'id')
    if (!isUuid(id)) return json({ message: 'شناسه معتبر نیست.', ok: false }, 400)

    const { body } = await readBody(req)

    // Refuse a second payment rather than overwrite the first. An operator posting
    // `pay` twice has almost certainly got the wrong invoice id, and the update would
    // quietly replace the reference of the payment that really happened — destroying
    // the only record tying money received to the invoice it settled.
    const current = await req.payload.findByID({
      id,
      collection: 'invoices',
      depth: 0,
      disableErrors: true,
      overrideAccess: true,
      req,
    })
    if (!current) return json({ message: 'صورتحساب پیدا نشد.', ok: false }, 404)
    if ((current as { status?: unknown }).status === 'paid') {
      return json(
        {
          message: `صورتحساب ${String((current as { number?: unknown }).number ?? '')} قبلاً پرداخت شده است.`,
          ok: false,
        },
        409,
      )
    }

    try {
      const doc = await req.payload.update({
        id,
        collection: 'invoices',
        data: {
          paidAt: typeof body?.paidAt === 'string' ? body.paidAt : new Date().toISOString(),
          paymentReference: typeof body?.reference === 'string' ? body.reference.slice(0, 200) : undefined,
        },
        depth: 1,
        overrideAccess: true,
        req,
      })

      const row = invoiceRow(doc as unknown as Record<string, unknown>)

      // A paid invoice clears a past-due subscription: the dunning state exists to be
      // left, and leaving it by hand is how a customer stays flagged after paying.
      if (row.site.id) {
        const subscription = await subscriptionForSite(req, row.site.id)
        if (subscription && subscription.status === 'pastDue') {
          await req.payload.update({
            id: String(subscription.id),
            collection: 'subscriptions',
            data: { status: 'active' },
            depth: 0,
            overrideAccess: true,
            req,
          })
        }
      }

      await emitPlatformEvent(req, {
        data: { number: row.number, total: row.total },
        event: 'invoice.paid',
        message: `صورتحساب ${row.number} پرداخت شد.`,
        site: row.site.id || null,
        targetCollection: 'invoices',
        targetId: row.id,
      })

      return json({ invoice: row, ok: true })
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

// ---------------------------------------------------------------------------
// Plugins, themes, feature flags
// ---------------------------------------------------------------------------

/**
 * `GET /api/platform/plugins?site=` — installed plugins, never their credentials.
 *
 * The `credential` column is masked by its own field hook, but this response is
 * built by hand from named fields anyway: a `select`-less passthrough is how a
 * future field starts leaking the day somebody adds it.
 */
export const pluginsListEndpoint: Endpoint = {
  path: '/platform/plugins',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const siteId = params.get('site')

    if (siteId) {
      if (!isUuid(siteId)) return json({ message: 'شناسهٔ سایت معتبر نیست.', ok: false }, 400)
      return json({ ok: true, plugins: await pluginsForSite(req, siteId) })
    }

    const { docs } = await req.payload.find({
      collection: 'plugins',
      depth: 0,
      limit: 200,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'name',
    })

    return json({
      ok: true,
      plugins: (docs as unknown as Record<string, unknown>[]).map((doc) => ({
        configured: typeof doc.credentialsSummary === 'string' && doc.credentialsSummary.includes('·'),
        enabled: doc.enabled === true,
        id: String(doc.id),
        key: String(doc.key ?? ''),
        name: String(doc.name ?? ''),
        scope: String(doc.scope ?? 'global'),
        settings: doc.settings ?? {},
        sites: Array.isArray(doc.sites) ? (doc.sites as unknown[]).map(String) : [],
        type: String(doc.type ?? 'custom'),
        version: doc.version ?? null,
      })),
    })
  },
}

/** `PATCH /api/platform/plugins/:id` — toggle, retarget or reconfigure a plugin (never its credential). */
export const pluginPatchEndpoint: Endpoint = {
  path: '/platform/plugins/:id',
  method: 'patch',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const id = param(req, 'id')
    if (!isUuid(id)) return json({ message: 'شناسه معتبر نیست.', ok: false }, 400)

    const { body, error } = await readBody(req)
    if (error) return error

    const data: Record<string, unknown> = {}
    if (typeof body?.enabled === 'boolean') data.enabled = body.enabled
    if (body?.settings && typeof body.settings === 'object') data.settings = body.settings
    if (typeof body?.scope === 'string' && ['global', 'sites'].includes(body.scope)) data.scope = body.scope
    if (Array.isArray(body?.sites)) data.sites = (body.sites as unknown[]).map(String).filter(isUuid)

    // `credential` is deliberately absent: a secret is typed into the admin form or
    // sent to nothing at all. An endpoint that accepts one is an endpoint that logs
    // one the first time somebody debugs it.
    if (!Object.keys(data).length) return json({ message: 'چیزی برای تغییر ارسال نشده است.', ok: false }, 400)

    try {
      const doc = await req.payload.update({ id, collection: 'plugins', data, depth: 0, overrideAccess: true, req })

      await emitPlatformEvent(req, {
        data: { enabled: doc.enabled === true, key: String(doc.key ?? '') },
        event: 'plugin.changed',
        message: `افزونهٔ «${doc.name}» ${doc.enabled ? 'روشن' : 'خاموش'} شد.`,
        targetCollection: 'plugins',
        targetId: id,
      })

      return json({ ok: true, plugin: { enabled: doc.enabled === true, id, key: String(doc.key ?? '') } })
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

/** `GET /api/platform/themes` — the theme catalogue an external builder offers. */
export const themesListEndpoint: Endpoint = {
  path: '/platform/themes',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const { docs } = await req.payload.find({
      collection: 'theme-templates',
      depth: 0,
      limit: 200,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'name',
    })

    return json({
      ok: true,
      themes: (docs as unknown as Record<string, unknown>[]).map((doc) => ({
        active: doc.active === true,
        description: doc.description ?? null,
        id: String(doc.id),
        isDefault: doc.isDefault === true,
        key: String(doc.key ?? ''),
        name: String(doc.name ?? ''),
        siteTypes: Array.isArray(doc.siteTypes) ? (doc.siteTypes as unknown[]).map(String) : [],
        tokens: doc.tokens ?? {},
      })),
    })
  },
}

/**
 * `POST /api/platform/sites/:id/theme` — apply a catalogue template to a site.
 *
 * A copy, not a link: see `ThemeTemplates`. `{ theme: "<key or uuid>" }`.
 */
export const applyThemeEndpoint: Endpoint = {
  path: '/platform/sites/:id/theme',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const result = await applyThemeTemplate(req, site, String(body?.theme ?? ''))
    if (!result.ok) return json(result, 400)

    await emitPlatformEvent(req, {
      data: { theme: result.theme },
      event: 'site.updated',
      message: `پوستهٔ «${result.theme}» روی ${site.domain} اعمال شد.`,
      site,
      targetCollection: 'theme',
      targetId: result.id,
    })

    return json(result)
  },
}

/** `GET /api/platform/features` — the feature catalogue, for a console that renders a matrix. */
export const featuresListEndpoint: Endpoint = {
  path: '/platform/features',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const { docs } = await req.payload.find({
      collection: 'feature-flags',
      depth: 0,
      limit: 500,
      overrideAccess: true,
      pagination: false,
      req,
      sort: 'key',
    })

    return json({
      features: (docs as unknown as Record<string, unknown>[]).map((doc) => ({
        category: String(doc.category ?? 'general'),
        defaultEnabled: doc.defaultEnabled === true,
        description: doc.description ?? null,
        id: String(doc.id),
        key: String(doc.key ?? ''),
        label: String(doc.label ?? ''),
      })),
      ok: true,
    })
  },
}

/**
 * `POST /api/platform/sites/:id/features` — force a feature on or off for one site.
 *
 * `{ key, enabled, reason? }`. Writes the third resolution layer
 * (`site-entitlements`), which is the only layer an operator should ever touch for
 * a single customer: editing the plan would move every customer on it.
 */
export const siteFeatureEndpoint: Endpoint = {
  path: '/platform/sites/:id/features',
  method: 'post',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const site = await siteById(req, param(req, 'id'))
    if (!site) return json({ message: 'سایت پیدا نشد.', ok: false }, 404)

    const { body, error } = await readBody(req)
    if (error) return error

    const key = slugKey(body?.key)
    if (!key) return json({ message: 'کلید امکان ارسال نشده است.', ok: false }, 400)

    const { docs: flags } = await req.payload.find({
      collection: 'feature-flags',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { key: { equals: key } },
    })

    const flag = flags[0]
    if (!flag) return json({ message: `امکان «${key}» در فهرست امکانات نیست.`, ok: false }, 404)

    const enabled = body?.enabled !== false
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined

    const { docs } = await req.payload.find({
      collection: 'site-entitlements',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { site: { equals: String(site.id) } },
    })

    type OverrideRow = { enabled: boolean; feature: string; reason?: string }
    const existing = docs[0] as { features?: unknown[]; id?: unknown } | undefined
    const rows: OverrideRow[] = Array.isArray(existing?.features)
      ? (existing.features as Record<string, unknown>[]).map((row) => ({
          enabled: row?.enabled === true,
          // Depth 0, so a relationship is the id string — but a populated read would
          // hand back the document, and silently stringifying that writes
          // "[object Object]" into the override and loses the row.
          feature: typeof row?.feature === 'string' ? row.feature : String((row?.feature as { id?: unknown })?.id ?? ''),
          reason: typeof row?.reason === 'string' ? row.reason : undefined,
        }))
      : []
    const index = rows.findIndex((row) => row.feature === String(flag.id))

    if (index >= 0) rows[index] = { ...rows[index], enabled, reason }
    else rows.push({ enabled, feature: String(flag.id), reason })

    try {
      if (existing?.id) {
        await req.payload.update({
          id: String(existing.id),
          collection: 'site-entitlements',
          data: { features: rows },
          depth: 0,
          overrideAccess: true,
          req,
        })
      } else {
        await req.payload.create({
          collection: 'site-entitlements',
          // `quotaEnforcement` is `required` with a default, and Payload's create type
          // demands required fields even when a default exists — so it is stated here
          // rather than cast away.
          data: { features: rows, quotaEnforcement: 'inherit', site: String(site.id) },
          depth: 0,
          overrideAccess: true,
          req,
        })
      }
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }

    return json({ entitlement: await resolveEntitlement(req, site), ok: true })
  },
}

// ---------------------------------------------------------------------------
// Audit and settings
// ---------------------------------------------------------------------------

/** `GET /api/platform/audit?action=&site=&limit=&page=` — the durable trail. */
export const auditListEndpoint: Endpoint = {
  path: '/platform/audit',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied
    const params = search(req)
    const action = params.get('action')
    const site = params.get('site')

    const result = await req.payload.find({
      collection: 'audit-log',
      depth: 0,
      limit: clampLimit(params.get('limit'), 50, 200),
      overrideAccess: true,
      page: clampPage(params.get('page')),
      req,
      sort: '-createdAt',
      where: {
        and: [
          ...(action && isPlatformEvent(action) ? [{ action: { equals: action } }] : []),
          ...(site && isUuid(site) ? [{ site: { equals: site } }] : []),
        ],
      },
    })

    return json({
      entries: (result.docs as unknown as Record<string, unknown>[]).map((doc) => ({
        action: String(doc.action ?? ''),
        actor: doc.actorEmail ?? null,
        actorType: String(doc.actorType ?? 'system'),
        at: doc.createdAt ?? null,
        changes: doc.changes ?? null,
        id: String(doc.id),
        ip: doc.ip ?? null,
        site: doc.site ? String(doc.site) : null,
        summary: String(doc.summary ?? ''),
        target: doc.targetCollection ? `${doc.targetCollection}:${doc.targetId ?? ''}` : null,
      })),
      ok: true,
      page: result.page ?? 1,
      totalDocs: result.totalDocs,
      totalPages: result.totalPages,
    })
  },
}

/** `GET /api/platform/settings` — the operator's own configuration, credential-free. */
export const settingsGetEndpoint: Endpoint = {
  path: '/platform/settings',
  method: 'get',
  handler: async (req) => {
    const denied = await requireOperator(req)
    if (denied) return denied

    const settings = await req.payload.findGlobal({
      slug: 'platform-settings',
      depth: 0,
      overrideAccess: true,
      req,
    })

    return json({ ok: true, settings, supportedEvents: PLATFORM_EVENT_NAMES })
  },
}

/**
 * `PATCH /api/platform/settings` — change platform policy.
 *
 * **Admin session only.** Everything else in this file accepts a platform key,
 * because a console needs to operate the deployment; this one route does not,
 * because it can switch off quota enforcement and open signups for the whole
 * platform at once. That is the deployment's root policy, and it should require the
 * credential a human logs in with — the same reasoning that keeps
 * `POST /api/payments/cancel` a session action.
 */
export const settingsPatchEndpoint: Endpoint = {
  path: '/platform/settings',
  method: 'patch',
  handler: async (req) => {
    const denied = requireAdminSession(req)
    if (denied) return denied

    const { body, error } = await readBody(req)
    if (error) return error

    const allowed = [
      'auditRetentionDays',
      'autoRenewInvoices',
      'billingEmail',
      'defaultSiteStatus',
      'deliveryRetentionDays',
      'invoiceDueDays',
      'invoiceFooter',
      'maintenanceMessage',
      'maintenanceMode',
      'maxSitesPerUser',
      'platformName',
      'quotaEnforcement',
      'quotaWarnPercent',
      'signupsOpen',
      'supportEmail',
      'supportUrl',
      'suspendOnQuotaExceeded',
      'taxPercent',
      'webhookMaxFailures',
      'webhookTimeoutMs',
    ]

    const data = Object.fromEntries(
      Object.entries(body ?? {}).filter(([key]) => allowed.includes(key)),
    )

    if (!Object.keys(data).length) {
      return json({ message: `هیچ فیلد قابل تغییری ارسال نشد. فیلدهای مجاز: ${allowed.join(', ')}`, ok: false }, 400)
    }

    try {
      const settings = await req.payload.updateGlobal({
        slug: 'platform-settings',
        data,
        depth: 0,
        overrideAccess: true,
        req,
      })

      await emitPlatformEvent(req, {
        data: { fields: Object.keys(data) },
        event: 'platform.settingsChanged',
        message: `تنظیمات سکو تغییر کرد: ${Object.keys(data).join('، ')}`,
      })

      return json({ ok: true, settings })
    } catch (err) {
      return json({ message: (err as Error)?.message ?? 'ذخیره نشد.', ok: false }, 400)
    }
  },
}

/**
 * Registration order matters: Payload matches in sequence, so `/platform/saas/overview`
 * and every literal `/platform/sites/:id/<word>` route must be registered before the
 * fleet file's bare `/platform/sites/:id`. `payload.config` spreads this array *first*
 * for exactly that reason.
 */
export const platformSaasEndpoints: Endpoint[] = [
  saasOverviewEndpoint,
  plansListEndpoint,
  subscriptionsListEndpoint,
  subscriptionUpsertEndpoint,
  subscriptionPatchEndpoint,
  invoicesListEndpoint,
  invoiceCreateEndpoint,
  invoicePayEndpoint,
  pluginsListEndpoint,
  pluginPatchEndpoint,
  themesListEndpoint,
  featuresListEndpoint,
  auditListEndpoint,
  settingsGetEndpoint,
  settingsPatchEndpoint,
  selfEntitlementEndpoint,
  // Site-scoped literals, all before the fleet file's `/platform/sites/:id`.
  siteEntitlementEndpoint,
  siteQuotaEndpoint,
  siteUsageEndpoint,
  siteFeatureEndpoint,
  applyThemeEndpoint,
]
