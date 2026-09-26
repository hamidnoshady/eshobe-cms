import type { Endpoint, PayloadRequest } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'
import { isUuid } from '@/lib/ids'
import { clampLimit, clampPage } from '@/lib/platform-control'
import { clampInt, isQuotaMetric, QUOTA_METRICS, slugKey, type QuotaMetric } from '@/lib/saas/plans'
import { PLATFORM_EVENT_NAMES, isPlatformEvent } from '@/lib/saas/events'
import { quotaReportForSite, resolveEntitlement, usageForSite } from '@/platform/entitlements'
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
// Legacy commercial routes
// ---------------------------------------------------------------------------

/**
 * Plans, subscriptions and invoices are no longer a CMS commercial API.
 * Authenticated callers get 410 so a console can tell "retired" from "forbidden".
 * Anonymous callers still get 403 from the operator guard.
 */
const retiredCommercial = async (req: PayloadRequest): Promise<Response> => {
  const denied = await requireOperator(req)
  if (denied) return denied
  return json(
    {
      commercialAuthority: 'cafe-restaurant-pos',
      message:
        'مدیریت طرح، اشتراک و صورتحساب در پلتفرم اشوب است. این مسیر در اشوب‌سی‌ام‌اس بازنشسته شده است.',
      ok: false,
    },
    410,
  )
}

/** Retired. Commercial plans live in cafe-restaurant-pos. */
export const plansListEndpoint: Endpoint = {
  path: '/platform/plans',
  method: 'get',
  handler: retiredCommercial,
}

/** Retired. */
export const subscriptionsListEndpoint: Endpoint = {
  path: '/platform/subscriptions',
  method: 'get',
  handler: retiredCommercial,
}

/** Retired. CMS does not upsert subscriptions. */
export const subscriptionUpsertEndpoint: Endpoint = {
  path: '/platform/subscriptions',
  method: 'post',
  handler: retiredCommercial,
}

/** Retired. */
export const subscriptionPatchEndpoint: Endpoint = {
  path: '/platform/subscriptions/:id',
  method: 'patch',
  handler: retiredCommercial,
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
 * `POST /api/platform/sites/:id/usage` — approximate operational quota counter.
 *
 * `usage-records` is a read-modify-write counter. Lost increments under concurrency
 * are acceptable for quota UX (`apiRequestsPerMonth`) and are not billable usage.
 * A billing meter key is refused here; financial quantities go through the signed
 * ingest path into `billing-usage-outbox`.
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

    const metric = String(body?.metric ?? body?.meterKey ?? '')
    const { isBillingMeterKey } = await import('@/billing/meters/registry')
    if (isBillingMeterKey(metric)) {
      return json(
        {
          message: 'سنجه‌های مالی از مسیر امضاشدهٔ صورت‌حساب ثبت می‌شوند، نه از شمارندهٔ تقریبی سهمیه.',
          ok: false,
        },
        400,
      )
    }
    if (!isQuotaMetric(metric)) {
      return json({ message: `سنجهٔ ناشناخته. مقادیر مجاز: ${QUOTA_METRICS.join(', ')}`, ok: false }, 400)
    }

    const amount = clampInt(body?.amount, 1, 1, 100_000)
    await recordUsage(req, { amount, metric: metric as QuotaMetric, siteId: String(site.id) })

    return json({
      approximate: true,
      metric,
      ok: true,
      usage: await usageForSite(req, String(site.id)),
    })
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
      authority: entitlement.authority,
      features: entitlement.featureMap,
      ok: true,
      planCode: entitlement.plan?.code ?? null,
      projectionVersion: entitlement.projectionVersion,
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
// Invoices — retired
// ---------------------------------------------------------------------------

/** Retired. */
export const invoicesListEndpoint: Endpoint = {
  path: '/platform/invoices',
  method: 'get',
  handler: retiredCommercial,
}

/** Retired. CMS does not create customer invoices. */
export const invoiceCreateEndpoint: Endpoint = {
  path: '/platform/invoices',
  method: 'post',
  handler: retiredCommercial,
}

/** Retired. Paying an invoice is a central Billing action. */
export const invoicePayEndpoint: Endpoint = {
  path: '/platform/invoices/:id/pay',
  method: 'post',
  handler: retiredCommercial,
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
 * `POST /api/platform/sites/:id/features` — a technical hold, not a commercial grant.
 *
 * `{ key, enabled: false, reason? }` adds the key to `technicalHolds`. `enabled: true`
 * is refused: a paid capability is granted by the central entitlement projection.
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
    if (!flags[0]) return json({ message: `امکان «${key}» در فهرست امکانات نیست.`, ok: false }, 404)

    if (body?.enabled !== false) {
      return json(
        {
          message: 'روشن‌کردن یک امکان حق تجاری است و فقط از پلتفرم اشوب می‌آید. اینجا فقط نگه‌داشت فنی مجاز است.',
          ok: false,
        },
        409,
      )
    }

    const { docs } = await req.payload.find({
      collection: 'site-entitlements',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: { site: { equals: String(site.id) } },
    })
    const existing = docs[0] as { id?: unknown; technicalHolds?: unknown } | undefined
    const holds = Array.isArray(existing?.technicalHolds)
      ? existing.technicalHolds.map((row) => String(row)).filter(Boolean)
      : []
    if (!holds.includes(key)) holds.push(key)

    try {
      if (existing?.id) {
        await req.payload.update({
          id: String(existing.id),
          collection: 'site-entitlements',
          data: { technicalHolds: holds },
          depth: 0,
          overrideAccess: true,
          req,
        })
      } else {
        await req.payload.create({
          collection: 'site-entitlements',
          data: { quotaEnforcement: 'inherit', site: String(site.id), technicalHolds: holds },
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
      'billingEmail',
      'defaultSiteStatus',
      'deliveryRetentionDays',
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
