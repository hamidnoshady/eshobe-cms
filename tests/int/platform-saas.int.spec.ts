// @vitest-environment node
//
// Same reason as `platform-control.int.spec.ts`: `createLocalReq({ user })` builds a
// real session, and `provisioning.int.spec.ts` documents the jsdom/jose
// incompatibility this whole family of specs shares.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import {
  applyThemeEndpoint,
  auditListEndpoint,
  featuresListEndpoint,
  invoiceCreateEndpoint,
  invoicePayEndpoint,
  invoicesListEndpoint,
  plansListEndpoint,
  pluginPatchEndpoint,
  pluginsListEndpoint,
  saasOverviewEndpoint,
  selfEntitlementEndpoint,
  settingsGetEndpoint,
  settingsPatchEndpoint,
  siteFeatureEndpoint,
  siteQuotaEndpoint,
  subscriptionsListEndpoint,
  subscriptionUpsertEndpoint,
} from '@/endpoints/platformSaas'
import { normalizeLimit, QUOTA_METRICS } from '@/lib/saas/plans'
import { resolveEntitlement } from '@/platform/entitlements'

/**
 * `/api/platform/*`, the commercial half — plans, subscriptions, invoices,
 * entitlements, plugins, themes, feature flags, settings and the audit trail. The
 * sibling POS's «سایت‌ساز» console runs the business through exactly these handlers,
 * so what they refuse matters as much as what they return.
 *
 * What this spec pins, beyond "the handlers answer":
 *
 *  - a **site** key reaches none of the operator surface, and anonymous reaches
 *    nothing at all — but a site key *can* read its own entitlement, which is the
 *    one route on this surface a customer's own app is meant to call;
 *  - `PATCH /platform/settings` is refused even to a platform *key* — rewriting the
 *    platform's own policy is a human decision with a session behind it;
 *  - entitlement resolution is plan → subscription override → site override, and a
 *    site with no subscription is entitled to nothing;
 *  - a quota is only *enforced* when the resolved policy says `enforce`; the default
 *    is `warn`, and warn must not block a create;
 *  - money is never summed across currencies, and a paid invoice revives a `pastDue`
 *    subscription;
 *  - secrets (a webhook's signing secret, a plugin's credentials) never come back
 *    out of a list endpoint.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

const siteId = { acme: '', shop: '' }
let platformKey = ''
let siteKey = ''
let planId = ''

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: email } },
  })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

const reqAsAdmin = async (extra?: Partial<PayloadRequest>): Promise<PayloadRequest> => {
  const admin = await userByEmail('admin@eshobe.test')
  // The fixture being an accidental platform admin is the one thing that would make
  // every assertion below pass vacuously.
  expect(admin.role).toBe('platformAdmin')
  return createLocalReq(
    { ...(extra ? { req: extra } : {}), user: { ...admin, collection: 'users' } },
    payload,
  )
}

const reqAsEditor = async (extra?: Partial<PayloadRequest>): Promise<PayloadRequest> => {
  const editor = await userByEmail('acme@eshobe.test')
  expect(editor.role).not.toBe('platformAdmin')
  return createLocalReq(
    { ...(extra ? { req: extra } : {}), user: { ...editor, collection: 'users' } },
    payload,
  )
}

const reqWithKey = (key: string, extra?: Partial<PayloadRequest>): Promise<PayloadRequest> =>
  createLocalReq(
    {
      req: { headers: new Headers({ authorization: `Bearer ${key}` }), ...extra } as Partial<PayloadRequest>,
    },
    payload,
  )

const withBody = (body: unknown): Partial<PayloadRequest> =>
  ({ json: async () => body } as Partial<PayloadRequest>)

const withUrl = (url: string): Partial<PayloadRequest> => ({ url } as Partial<PayloadRequest>)

/**
 * `any` on purpose, and only here: these responses are hand-built JSON with a
 * different shape per route, and threading a type per endpoint through a spec would
 * assert the types rather than the behaviour.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = async (res: Response): Promise<Record<string, any>> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await res.json()) as Record<string, any>

/**
 * `resolveEntitlement` takes the site *document*, not its id — deliberately, so that
 * a caller that already has the site (every endpoint on this surface does) does not
 * re-read it. Tests do not, hence this.
 */
const entitlementFor = async (id: string) => {
  const req = await reqAsAdmin()
  const site = await payload.findByID({ collection: 'sites', depth: 0, id, overrideAccess: true, req })
  return resolveEntitlement(req, site as unknown as Record<string, unknown>)
}

const issueKey = async (body: Record<string, unknown>): Promise<string> => {
  const req = await reqAsAdmin(withBody(body))
  const res = await issueApiKeyEndpoint.handler!(req)
  const json = (await res.json()) as { key?: string }
  if (!json.key) throw new Error('key issue failed')
  return json.key
}

beforeAll(async () => {
  payload = await getPayload({ config })

  for (const slug of ['acme', 'shop'] as const) {
    const { docs } = await payload.find({
      collection: 'sites',
      depth: 0,
      limit: 1,
      where: { slug: { equals: slug } },
    })
    if (!docs[0]) throw new Error(`Site ${slug} missing — run \`pnpm seed\``)
    siteId[slug] = String(docs[0].id)
  }

  platformKey = await issueKey({ name: 'کنسول سکو (تست SaaS)', role: 'platform' })
  siteKey = await issueKey({ name: 'سایت آکمه (تست SaaS)', role: 'site', siteId: siteId.acme })

  // The fixture plan. `pages: 2` is deliberately tiny so the quota assertions can
  // actually reach the limit without seeding hundreds of documents.
  const existing = await payload.find({
    collection: 'plans',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { code: { equals: 'test-starter' } },
  })

  planId = String(
    existing.docs[0]?.id ??
      (
        await payload.create({
          collection: 'plans',
          data: {
            active: true,
            code: 'test-starter',
            currency: 'IRT',
            interval: 'monthly',
            limits: { pages: 2, posts: 0, products: 50 },
            name: 'استارتر تست',
            price: 250_000,
          },
          overrideAccess: true,
        })
      ).id,
  )
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('quota arithmetic', () => {
  it('treats blank and zero as unlimited, not as a limit of nothing', () => {
    // The trap this encodes: a plan row saved with an empty `posts` box must mean
    // "we did not limit posts", never "this customer may create zero posts". A
    // number field left alone is the overwhelmingly common state of a new plan.
    expect(normalizeLimit(undefined)).toBeNull()
    expect(normalizeLimit(null)).toBeNull()
    expect(normalizeLimit('')).toBeNull()
    expect(normalizeLimit(0)).toBeNull()
    expect(normalizeLimit(-3)).toBeNull()
    expect(normalizeLimit(25)).toBe(25)
    expect(normalizeLimit('25')).toBe(25)
    expect(normalizeLimit(25.7)).toBe(25)
  })

  it('keeps the metric list closed', () => {
    // Every metric here needs a counter in `src/platform/usage.ts`; a metric added
    // to the plan UI with no counter behind it silently never enforces.
    expect([...QUOTA_METRICS].sort()).toEqual(
      [
        'apiKeys',
        'apiRequestsPerMonth',
        'categories',
        'domains',
        'media',
        'mediaStorageMb',
        'ordersPerMonth',
        'pages',
        'posts',
        'products',
        'users',
      ].sort(),
    )
  })
})

// ---------------------------------------------------------------------------
// The admin split
// ---------------------------------------------------------------------------

describe('admin visibility', () => {
  /**
   * `admin.hidden` is a server-only function of the user, so it can be resolved
   * directly against the built config — no browser needed, and every collection is
   * covered rather than the handful an e2e spec would click through.
   *
   * This is the panel half of the task: an operator opening `/admin` sees the SaaS,
   * a customer's staff see their website, and neither is shown the other's screens.
   * It is *not* the security boundary — that is `access`, asserted above — which is
   * why a collection appearing in the wrong list here is a usability bug and a
   * collection missing `platformAdmin` access is an incident.
   */
  type Shape = { admin?: { hidden?: unknown }; slug: string }

  const resolve = (slug: string, role: 'editor' | 'platformAdmin'): boolean => {
    const entry = (payload.config.collections as unknown as (Shape & { config?: Shape })[])
      .map((item) => item.config ?? item)
      .find((item) => item.slug === slug)
    if (!entry) throw new Error(`collection ${slug} is not registered`)
    const hidden = entry.admin?.hidden
    if (typeof hidden === 'boolean') return hidden
    if (typeof hidden !== 'function') return false
    return (hidden as (args: { user: unknown }) => boolean)({ user: { email: 'x', id: 'x', role } })
  }

  const CONTROL_PLANE = [
    'plans',
    'subscriptions',
    'invoices',
    'site-entitlements',
    'usage-records',
    'feature-flags',
    'plugins',
    'theme-templates',
    'webhooks',
    'webhook-deliveries',
    'audit-log',
    'api-keys',
    'storage-connections',
    'cdn-zones',
  ]

  const SITE_CONTENT = ['pages', 'posts', 'categories', 'media', 'products', 'orders', 'store', 'theme']

  it('shows a platform admin the control plane and not the content', () => {
    // The escape hatch would make this vacuous: it exists for support work and for
    // the e2e suite, and a test run with it set is not testing the split.
    expect(process.env.PLATFORM_ADMIN_SHOW_SITE_COLLECTIONS).not.toBe('true')

    for (const slug of CONTROL_PLANE) expect(resolve(slug, 'platformAdmin'), slug).toBe(false)
    for (const slug of SITE_CONTENT) expect(resolve(slug, 'platformAdmin'), slug).toBe(true)
  })

  it('shows a customer’s staff their website and not the control plane', () => {
    for (const slug of SITE_CONTENT) expect(resolve(slug, 'editor'), slug).toBe(false)
    for (const slug of CONTROL_PLANE) expect(resolve(slug, 'editor'), slug).toBe(true)
  })

  it('files every control-plane collection under a platform nav group', () => {
    // A collection with no group lands in Payload's ungrouped top section, above the
    // named ones — so one forgotten `group` puts a billing screen above «سکو — ناوگان»
    // and the operator's nav stops reading as a console.
    type Grouped = { admin?: { group?: unknown }; slug: string }
    const entries = (payload.config.collections as unknown as (Grouped & { config?: Grouped })[]).map(
      (item) => item.config ?? item,
    )

    for (const slug of CONTROL_PLANE) {
      const group = entries.find((entry) => entry.slug === slug)?.admin?.group
      expect(typeof group === 'string' ? group : '', slug).not.toBe('')
    }
  })
})

// ---------------------------------------------------------------------------
// Who may reach the operator surface
// ---------------------------------------------------------------------------

describe('access', () => {
  const operatorRoutes = [
    ['saas/overview', saasOverviewEndpoint],
    ['plans', plansListEndpoint],
    ['subscriptions', subscriptionsListEndpoint],
    ['invoices', invoicesListEndpoint],
    ['plugins', pluginsListEndpoint],
    ['features', featuresListEndpoint],
    ['audit', auditListEndpoint],
    ['settings', settingsGetEndpoint],
  ] as const

  it('refuses an anonymous caller everywhere', async () => {
    for (const [name, endpoint] of operatorRoutes) {
      const res = await endpoint.handler!(await createLocalReq({}, payload))
      expect(res.status, name).toBe(403)
    }
  })

  it('refuses a site key everywhere on the operator surface', async () => {
    for (const [name, endpoint] of operatorRoutes) {
      const res = await endpoint.handler!(await reqWithKey(siteKey, withUrl('http://t/api/platform/x')))
      expect(res.status, name).toBe(403)
    }
  })

  it('refuses a customer’s own staff, however senior, everywhere', async () => {
    // A site owner is an admin *of their website*. The platform's plans and every
    // other customer's invoices are not theirs to read, and the panel hiding the nav
    // link is not what stops them — this is.
    for (const [name, endpoint] of operatorRoutes) {
      const res = await endpoint.handler!(await reqAsEditor(withUrl('http://t/api/platform/x')))
      expect(res.status, name).toBe(403)
    }
  })

  it('admits a platform key and a platform-admin session', async () => {
    for (const [name, endpoint] of operatorRoutes) {
      const viaKey = await endpoint.handler!(await reqWithKey(platformKey, withUrl('http://t/api/platform/x')))
      expect(viaKey.status, `${name} (key)`).toBe(200)
      const viaSession = await endpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/x')))
      expect(viaSession.status, `${name} (session)`).toBe(200)
    }
  })

  it('never lets any of it be cached', async () => {
    // Every one of these answers is either a secret-adjacent operator report or a
    // per-caller entitlement; a shared cache in front of the app must not keep one.
    const res = await saasOverviewEndpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/saas/overview')))
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a platform key on PATCH /platform/settings, session only', async () => {
    // Turning on maintenance mode or flipping quota enforcement to `enforce` changes
    // the behaviour of every site at once. A long-lived key in another app's config
    // is the wrong credential for that; a human's session is the right one.
    const viaKey = await settingsPatchEndpoint.handler!(
      await reqWithKey(platformKey, withBody({ maintenanceMode: true })),
    )
    expect(viaKey.status).toBe(403)

    const { settings } = await bodyOf(
      await settingsGetEndpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/settings'))),
    )
    expect(settings.maintenanceMode).not.toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Subscriptions and entitlement
// ---------------------------------------------------------------------------

describe('subscriptions and entitlement', () => {
  it('entitles a site to nothing until it has a live subscription', async () => {
    const entitlement = await entitlementFor(siteId.shop)
    expect(entitlement.serving).toBe(false)
    expect(entitlement.plan).toBeNull()
    // Not "unlimited": a site nobody is paying for has no plan's limits to inherit,
    // and reporting unlimited here would make the overage report useless.
    expect(entitlement.featureMap).toEqual({})
  })

  it('upserts rather than stacking a second subscription on one site', async () => {
    // 201 the first time on a fresh database, 200 when a previous run already left a
    // subscription here. Asserting either exactly would make the spec depend on
    // whether `pnpm seed` had just run, which is not what it is testing.
    const first = await subscriptionUpsertEndpoint.handler!(
      await reqAsAdmin(withBody({ plan: 'test-starter', siteId: siteId.acme, status: 'active' })),
    )
    expect([200, 201]).toContain(first.status)

    // The second call must be an *update*, hence 200 and never 201 — that is the
    // upsert, and a 201 here would mean a second row.
    const second = await subscriptionUpsertEndpoint.handler!(
      await reqAsAdmin(withBody({ plan: 'test-starter', siteId: siteId.acme, status: 'active' })),
    )
    expect(second.status).toBe(200)

    const { totalDocs } = await payload.count({
      collection: 'subscriptions',
      overrideAccess: true,
      where: { site: { equals: siteId.acme } },
    })
    // One site, one live subscription — "which plan is this customer on?" must have
    // exactly one answer, and billing two rows at once is how a customer gets
    // charged twice.
    expect(totalDocs).toBe(1)
  })

  it('accepts a plan by code or by id', async () => {
    const byId = await subscriptionUpsertEndpoint.handler!(
      await reqAsAdmin(withBody({ plan: planId, siteId: siteId.acme, status: 'active' })),
    )
    expect(byId.status).toBe(200)

    const missing = await subscriptionUpsertEndpoint.handler!(
      await reqAsAdmin(withBody({ plan: 'no-such-plan', siteId: siteId.acme })),
    )
    expect(missing.status).toBe(404)
  })

  it('resolves plan limits, then subscription overrides, then site overrides', async () => {
    const base = await entitlementFor(siteId.acme)
    expect(base.serving).toBe(true)
    expect(base.limits.pages).toBe(2)
    // `posts: 0` on the plan is unlimited, so the merged map has no entry at all —
    // "absent" and "unlimited" are deliberately the same state, which is what stops a
    // half-filled plan row from reading as a limit of zero.
    expect(base.limits.posts ?? null).toBeNull()

    const { docs } = await payload.find({
      collection: 'subscriptions',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: siteId.acme } },
    })
    await payload.update({
      collection: 'subscriptions',
      data: { limitOverrides: { pages: 9 } },
      id: String(docs[0]!.id),
      overrideAccess: true,
    })

    const overridden = await entitlementFor(siteId.acme)
    expect(overridden.limits.pages).toBe(9)
    // Only the stated key moves; an override object is a patch, not a replacement.
    expect(overridden.limits.products).toBe(50)

    await payload.update({
      collection: 'subscriptions',
      data: { limitOverrides: {} },
      id: String(docs[0]!.id),
      overrideAccess: true,
    })
  })

  it('lets a site key read its own entitlement and nobody else’s', async () => {
    const mine = await selfEntitlementEndpoint.handler!(await reqWithKey(siteKey))
    expect(mine.status).toBe(200)
    const body = await bodyOf(mine)
    expect(body.site.id).toBe(siteId.acme)
    expect(body.serving).toBe(true)
    // Deliberately not the exact counts: this is the one route a *customer's* app
    // calls, and it gets what it can act on — am I served, which features, what am I
    // out of — not a report on the operator's business.
    expect(body.quota.exceeded).toBeDefined()

    // A platform key has no single site, so this route has nothing to answer for it —
    // it is the *customer's* view of its own plan, and the operator's view is
    // `GET /platform/sites/:id/entitlement`.
    const operator = await selfEntitlementEndpoint.handler!(await reqWithKey(platformKey))
    expect(operator.status).toBe(403)
  })

  it('reports usage against the limit without blocking anything by default', async () => {
    const res = await siteQuotaEndpoint.handler!(
      await reqAsAdmin({ routeParams: { id: siteId.acme } } as Partial<PayloadRequest>),
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)

    // The platform default is `warn`: the report shows the overage, the customer is
    // not stopped. Anything else makes a half-filled plan row an outage.
    expect(body.enforcement).toBe('warn')
    const pages = body.lines.find((line: { metric?: string }) => line.metric === 'pages')
    expect(pages.limit).toBe(2)
    expect(typeof pages.used).toBe('number')
  })

  it('keeps a pastDue site serving', async () => {
    const { docs } = await payload.find({
      collection: 'subscriptions',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: siteId.acme } },
    })
    const id = String(docs[0]!.id)

    await payload.update({ collection: 'subscriptions', data: { status: 'pastDue' }, id, overrideAccess: true })

    const entitlement = await entitlementFor(siteId.acme)
    // A missed payment is a conversation, not a kill switch: the site stays up and
    // keeps its plan's limits. Suspension is a separate, deliberate operator action.
    expect(entitlement.serving).toBe(true)
    expect(entitlement.limits.pages).toBe(2)

    await payload.update({ collection: 'subscriptions', data: { status: 'active' }, id, overrideAccess: true })
  })
})

// ---------------------------------------------------------------------------
// Quota enforcement
// ---------------------------------------------------------------------------

describe('quota enforcement', () => {
  // `layout` is required on `pages`; a bare title would fail validation before the
  // quota hook is even reached, which would make these assertions pass vacuously.
  const pageData = (title: string) => ({
    layout: [{ blockType: 'content', columns: [] }],
    site: siteId.acme,
    slug: `quota-${title}`,
    title: `سنجش سقف ${title}`,
  })

  it('does not block a create while the policy is warn', async () => {
    const editor = await userByEmail('acme@eshobe.test')
    const created = await payload.create({
      collection: 'pages',
      data: pageData('warn') as never,
      overrideAccess: false,
      user: editor,
    })
    expect(created.id).toBeTruthy()
    await payload.delete({ collection: 'pages', id: String(created.id), overrideAccess: true })
  })

  it('blocks a create with 402 once the site’s own policy says enforce', async () => {
    // Enforcement set on the *site entitlement*, not the platform default — a single
    // customer over their plan is the normal case, and the operator should be able
    // to hold the line on one account without arming it for everyone.
    const entitlementDoc = await payload.create({
      collection: 'site-entitlements',
      data: { limitOverrides: { pages: 1 }, quotaEnforcement: 'enforce', site: siteId.acme },
      overrideAccess: true,
    })

    try {
      const editor = await userByEmail('acme@eshobe.test')
      await expect(
        payload.create({
          collection: 'pages',
          data: pageData('enforce') as never,
          overrideAccess: false,
          user: editor,
        }),
      ).rejects.toThrow(/سقف|طرح/)

      // …and a platform admin is never stopped: support work happens over the
      // customer's limit by definition.
      const rescue = await payload.create({
        collection: 'pages',
        data: pageData('rescue') as never,
        overrideAccess: false,
        user: await userByEmail('admin@eshobe.test'),
      })
      expect(rescue.id).toBeTruthy()
      await payload.delete({ collection: 'pages', id: String(rescue.id), overrideAccess: true })
    } finally {
      await payload.delete({
        collection: 'site-entitlements',
        id: String(entitlementDoc.id),
        overrideAccess: true,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

describe('invoices', () => {
  it('derives the total server-side and never trusts a posted one', async () => {
    const res = await invoiceCreateEndpoint.handler!(
      await reqAsAdmin(
        withBody({
          currency: 'IRT',
          lines: [
            { description: 'اشتراک ماهانه', quantity: 2, unitAmount: 250_000 },
            { description: 'دامنه', quantity: 1, unitAmount: 100_000 },
          ],
          siteId: siteId.acme,
          total: 1, // a client claiming the invoice is worth one rial
        }),
      ),
    )
    expect(res.status).toBe(201)
    const { invoice } = await bodyOf(res)
    expect(invoice.total).toBe(600_000)
    expect(invoice.number).toMatch(/^INV-\d{4}-\d{6}$/)
  })

  it('marks an invoice paid once, and revives a pastDue subscription when it is', async () => {
    const { docs: subs } = await payload.find({
      collection: 'subscriptions',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: siteId.acme } },
    })
    const subscriptionId = String(subs[0]!.id)
    await payload.update({
      collection: 'subscriptions',
      data: { status: 'pastDue' },
      id: subscriptionId,
      overrideAccess: true,
    })

    const created = await bodyOf(
      await invoiceCreateEndpoint.handler!(
        await reqAsAdmin(
          withBody({
            lines: [{ description: 'تمدید', quantity: 1, unitAmount: 250_000 }],
            siteId: siteId.acme,
            subscriptionId,
          }),
        ),
      ),
    )

    const paid = await invoicePayEndpoint.handler!(
      await reqAsAdmin({
        ...withBody({ reference: 'TEST-REF-1' }),
        routeParams: { id: String(created.invoice.id) },
      } as Partial<PayloadRequest>),
    )
    expect(paid.status).toBe(200)
    expect((await bodyOf(paid)).invoice.status).toBe('paid')

    const after = await payload.findByID({
      collection: 'subscriptions',
      depth: 0,
      id: subscriptionId,
      overrideAccess: true,
    })
    // The whole point of recording the payment: the thing the customer was past due
    // on is settled, so they are not past due any more. Leaving that to a human is
    // how a paying customer keeps getting dunning emails.
    expect(after.status).toBe('active')

    const twice = await invoicePayEndpoint.handler!(
      await reqAsAdmin({
        ...withBody({ reference: 'TEST-REF-2' }),
        routeParams: { id: String(created.invoice.id) },
      } as Partial<PayloadRequest>),
    )
    expect(twice.status).toBe(409)
  })

  it('reports money per currency, never as one number', async () => {
    const res = await saasOverviewEndpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/saas/overview')))
    const { overview } = await bodyOf(res)
    expect(Array.isArray(overview.billing.collected)).toBe(true)
    for (const row of overview.billing.collected) {
      expect(typeof row.code).toBe('string')
      expect(Number.isInteger(row.minorTotal)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Extensions: plugins, themes, feature flags
// ---------------------------------------------------------------------------

describe('extensions', () => {
  it('never returns a plugin’s credentials or a webhook’s secret', async () => {
    const plugin = await payload.create({
      collection: 'plugins',
      data: {
        credential: 'super-secret-token',
        enabled: true,
        key: 'test-analytics',
        name: 'تحلیل تست',
        scope: 'global',
        type: 'analytics',
      },
      overrideAccess: true,
    })

    try {
      const res = await pluginsListEndpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/plugins')))
      const text = JSON.stringify(await bodyOf(res))
      // Not "it is masked in the UI" — the bytes must not leave the process. A
      // console rendering this list is one `console.log` away from a support ticket
      // containing a live credential.
      expect(text).not.toContain('super-secret-token')

      const patched = await pluginPatchEndpoint.handler!(
        await reqAsAdmin({
          ...withBody({ enabled: false }),
          routeParams: { id: String(plugin.id) },
        } as Partial<PayloadRequest>),
      )
      expect(patched.status).toBe(200)
      expect(JSON.stringify(await bodyOf(patched))).not.toContain('super-secret-token')

      const stored = await payload.findByID({
        collection: 'plugins',
        depth: 0,
        id: String(plugin.id),
        overrideAccess: true,
      })
      expect(stored.enabled).toBe(false)
      // Toggling a plugin off must not have wiped the credential it will need when
      // it is turned back on — a blank secret field means "unchanged".
      expect(String(stored.credential ?? '')).not.toBe('')
    } finally {
      await payload.delete({ collection: 'plugins', id: String(plugin.id), overrideAccess: true })
    }
  })

  it('copies a theme template onto a site, as a copy and not a link', async () => {
    /**
     * This test repaints a *seeded* site's live theme, and `tenancy.int.spec.ts` and
     * `headless.int.spec.ts` both assert acme's exact seeded colour. Restoring it in
     * `finally` is not tidiness — without it this spec turns two unrelated specs red
     * depending on file order, which is the worst kind of flake to chase.
     */
    const original = (
      await payload.find({
        collection: 'theme',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        where: { site: { equals: siteId.acme } },
      })
    ).docs[0]

    const template = await payload.create({
      collection: 'theme-templates',
      data: {
        key: 'test-template',
        name: 'قالب تست',
        tokens: { accent: '#ff0000', primary: '#00ff00' },
      },
      overrideAccess: true,
    })

    try {
      const res = await applyThemeEndpoint.handler!(
        await reqAsAdmin({
          ...withBody({ theme: 'test-template' }),
          routeParams: { id: siteId.acme },
        } as Partial<PayloadRequest>),
      )
      expect(res.status).toBe(200)

      const after = await payload.find({
        collection: 'theme',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        where: { site: { equals: siteId.acme } },
      })
      const doc = after.docs[0] as unknown as Record<string, unknown>
      expect(doc.primary).toBe('#00ff00')
      expect(doc.accent).toBe('#ff0000')
      /**
       * A template is a *complete* palette, not a patch: every token field in the
       * group carries a `defaultValue`, so the two written above arrived alongside a
       * full set of defaults and `radius` moved with them. That is intended — half a
       * palette applied over another half is how a site ends up with a teal button
       * on a maroon header.
       *
       * The allowlist in `applyThemeTemplate` is therefore not about partial
       * templates; it is about *time*. A token added to `theme` in a later release
       * has no field in the templates stored today, so it stays `undefined` here and
       * is left alone rather than blanked — which is what the next assertion pins.
       */
      expect(doc.radius).toBe('md')

      // Change one token by hand, re-apply, and the site is back to the template:
      // the copy is authoritative at the moment it is made, and nothing links back.
      await payload.update({
        collection: 'theme',
        data: { primary: '#111111' },
        id: String(doc.id),
        overrideAccess: true,
      })
      await payload.update({
        collection: 'theme-templates',
        data: { tokens: { accent: '#ff0000', primary: '#222222' } },
        id: String(template.id),
        overrideAccess: true,
      })

      const unchanged = await payload.findByID({
        collection: 'theme',
        depth: 0,
        id: String(doc.id),
        overrideAccess: true,
      })
      // Editing the catalogue entry did **not** repaint the live site. This is the
      // whole reason the template is copied rather than related.
      expect(unchanged.primary).toBe('#111111')
    } finally {
      await payload.delete({ collection: 'theme-templates', id: String(template.id), overrideAccess: true })
      if (original) {
        await payload.update({
          collection: 'theme',
          data: {
            accent: original.accent,
            background: original.background,
            foreground: original.foreground,
            lineHeight: original.lineHeight,
            primary: original.primary,
            radius: original.radius,
          },
          id: String(original.id),
          overrideAccess: true,
        })
      }
    }
  })

  it('overrides a feature flag for one site without touching the default', async () => {
    const flag = await payload.create({
      collection: 'feature-flags',
      data: { defaultEnabled: false, key: 'test-beta-editor', label: 'ویرایشگر آزمایشی' },
      overrideAccess: true,
    })

    try {
      const res = await siteFeatureEndpoint.handler!(
        await reqAsAdmin({
          ...withBody({ enabled: true, key: 'test-beta-editor', reason: 'مشتری آزمایشی' }),
          routeParams: { id: siteId.acme },
        } as Partial<PayloadRequest>),
      )
      expect(res.status).toBe(200)

      const mine = await entitlementFor(siteId.acme)
      expect(mine.featureMap['test-beta-editor']).toBe(true)

      const other = await entitlementFor(siteId.shop)
      expect(other.featureMap['test-beta-editor']).not.toBe(true)

      const stored = await payload.findByID({
        collection: 'feature-flags',
        depth: 0,
        id: String(flag.id),
        overrideAccess: true,
      })
      expect(stored.defaultEnabled).toBe(false)
    } finally {
      const { docs } = await payload.find({
        collection: 'site-entitlements',
        depth: 0,
        limit: 10,
        overrideAccess: true,
        where: { site: { equals: siteId.acme } },
      })
      for (const doc of docs) {
        await payload.delete({ collection: 'site-entitlements', id: String(doc.id), overrideAccess: true })
      }
      await payload.delete({ collection: 'feature-flags', id: String(flag.id), overrideAccess: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe('audit trail', () => {
  it('records who changed what, and never records the secret they changed', async () => {
    const res = await auditListEndpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/audit?limit=50')))
    expect(res.status).toBe(200)
    const { entries } = await bodyOf(res)
    expect(Array.isArray(entries)).toBe(true)

    // The subscription upserts above went through `emitPlatformEvent`, so the trail
    // has them — an operator surface with no record of who changed a customer's plan
    // is not auditable.
    const subscriptionEntry = entries.find((entry: { action?: string }) =>
      String(entry.action ?? '').startsWith('subscription.'),
    )
    expect(subscriptionEntry).toBeTruthy()
    expect(subscriptionEntry.actor).toBeTruthy()

    const text = JSON.stringify(entries)
    expect(text).not.toContain('super-secret-token')
    expect(text.toLowerCase()).not.toContain('payload_secret')
  })
})
