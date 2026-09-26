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
 * `/api/platform/*` on the execution plane. Commercial plan, subscription and
 * invoice writes are retired (410). Entitlement for a site with no central
 * projection falls back to the read-only legacy merge, which entitles nothing
 * when no archived subscription exists. Quota enforcement stays local.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

const siteId = { acme: '', shop: '' }
let platformKey = ''
let siteKey = ''

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
    // The commercial archive is not an operator screen.
    for (const slug of ['plans', 'subscriptions', 'invoices']) {
      expect(resolve(slug, 'platformAdmin'), slug).toBe(true)
    }
  })

  it('shows a customer’s staff their website and not the control plane', () => {
    for (const slug of SITE_CONTENT) expect(resolve(slug, 'editor'), slug).toBe(false)
    for (const slug of CONTROL_PLANE) expect(resolve(slug, 'editor'), slug).toBe(true)
  })

  it('files every control-plane collection under a platform nav group', () => {
    // A collection with no group lands in Payload's ungrouped top section, above the
    // named ones. The sidebar itself is now driven by src/admin/navigation.ts, but
    // `admin.group` still labels each collection's breadcrumb, so it must stay set.
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
    ['plugins', pluginsListEndpoint],
    ['features', featuresListEndpoint],
    ['audit', auditListEndpoint],
    ['settings', settingsGetEndpoint],
  ] as const

  const retiredRoutes = [
    ['plans', plansListEndpoint],
    ['subscriptions', subscriptionsListEndpoint],
    ['invoices', invoicesListEndpoint],
  ] as const

  it('refuses an anonymous caller everywhere', async () => {
    for (const [name, endpoint] of [...operatorRoutes, ...retiredRoutes]) {
      const res = await endpoint.handler!(await createLocalReq({}, payload))
      expect(res.status, name).toBe(403)
    }
  })

  it('refuses a site key everywhere on the operator surface', async () => {
    for (const [name, endpoint] of [...operatorRoutes, ...retiredRoutes]) {
      const res = await endpoint.handler!(await reqWithKey(siteKey, withUrl('http://t/api/platform/x')))
      expect(res.status, name).toBe(403)
    }
  })

  it('refuses a customer’s own staff, however senior, everywhere', async () => {
    // A site owner is an admin *of their website*. The platform's plans and every
    // other customer's invoices are not theirs to read, and the panel hiding the nav
    // link is not what stops them — this is.
    for (const [name, endpoint] of [...operatorRoutes, ...retiredRoutes]) {
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
    for (const [name, endpoint] of retiredRoutes) {
      const viaKey = await endpoint.handler!(await reqWithKey(platformKey, withUrl('http://t/api/platform/x')))
      expect(viaKey.status, `${name} (key)`).toBe(410)
      const viaSession = await endpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/x')))
      expect(viaSession.status, `${name} (session)`).toBe(410)
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

  it('refuses to write archived invoice settings', async () => {
    const res = await settingsPatchEndpoint.handler!(
      await reqAsAdmin(
        withBody({
          autoRenewInvoices: false,
          invoiceDueDays: 1,
          invoiceFooter: 'باید نادیده بماند',
          taxPercent: 9,
        }),
      ),
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Entitlement and retired commercial routes
// ---------------------------------------------------------------------------

describe('entitlement', () => {
  it('entitles a site to nothing until a projection or archived subscription exists', async () => {
    const entitlement = await entitlementFor(siteId.shop)
    expect(entitlement.serving).toBe(false)
    expect(entitlement.plan).toBeNull()
    expect(entitlement.featureMap).toEqual({})
  })

  it('refuses commercial subscription writes', async () => {
    const res = await subscriptionUpsertEndpoint.handler!(
      await reqAsAdmin(withBody({ plan: 'test-starter', siteId: siteId.acme, status: 'active' })),
    )
    expect(res.status).toBe(410)
    await expect(
      payload.create({
        collection: 'subscriptions',
        data: { site: siteId.acme, status: 'active' } as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/بایگانی|پلتفرم/)
  })

  it('lets a site key read its own entitlement and nobody else’s', async () => {
    const mine = await selfEntitlementEndpoint.handler!(await reqWithKey(siteKey))
    expect(mine.status).toBe(200)
    const body = await bodyOf(mine)
    expect(body.site.id).toBe(siteId.acme)
    expect(body.price).toBeUndefined()
    expect(body.wallet).toBeUndefined()
    expect(body.quota.exceeded).toBeDefined()
    expect(JSON.stringify(body)).not.toContain('businessId')

    const operator = await selfEntitlementEndpoint.handler!(await reqWithKey(platformKey))
    expect(operator.status).toBe(403)
  })

  it('reports quota state without a commercial total', async () => {
    const res = await siteQuotaEndpoint.handler!(
      await reqAsAdmin({ routeParams: { id: siteId.acme } } as Partial<PayloadRequest>),
    )
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.enforcement).toBe('warn')
    const pages = body.lines.find((line: { metric?: string }) => line.metric === 'pages')
    expect(typeof pages.used).toBe('number')
    expect(body.revenue).toBeUndefined()
  })
})

describe('quota enforcement', () => {
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

  it('blocks a create once projected limits and local enforce say so', async () => {
    const { writeProjection } = await import('@/billing/entitlement/store')
    const req = await reqAsAdmin()
    const written = await writeProjection(req, {
      features: {},
      limits: { pages: { state: 'limit', value: 1 } },
      planCode: 'central-starter',
      serving: true,
      siteId: siteId.acme,
      source: 'push',
      version: 1,
    })
    expect(written.ok).toBe(true)

    const entitlementDoc = await payload.create({
      collection: 'site-entitlements',
      data: { limitOverrides: { pages: 999 }, quotaEnforcement: 'enforce', site: siteId.acme },
      overrideAccess: true,
    })
    const stored = await payload.findByID({
      collection: 'site-entitlements',
      depth: 0,
      id: String(entitlementDoc.id),
      overrideAccess: true,
    })
    expect(stored.limitOverrides?.pages ?? null).toBeNull()

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

      const rescue = await payload.create({
        collection: 'pages',
        data: pageData('rescue') as never,
        overrideAccess: false,
        user: await userByEmail('admin@eshobe.test'),
      })
      expect(rescue.id).toBeTruthy()
      await payload.delete({ collection: 'pages', id: String(rescue.id), overrideAccess: true })
    } finally {
      await payload.delete({ collection: 'site-entitlements', id: String(entitlementDoc.id), overrideAccess: true })
      const { docs } = await payload.find({
        collection: 'central-entitlement-projections',
        depth: 0,
        limit: 5,
        overrideAccess: true,
        where: { site: { equals: siteId.acme } },
      })
      for (const doc of docs) {
        await payload.delete({ collection: 'central-entitlement-projections', id: String(doc.id), overrideAccess: true })
      }
    }
  })
})

describe('retired invoices', () => {
  it('refuses invoice creation and payment', async () => {
    const created = await invoiceCreateEndpoint.handler!(
      await reqAsAdmin(withBody({ lines: [{ description: 'x', quantity: 1, unitAmount: 1 }], siteId: siteId.acme, total: 1 })),
    )
    expect(created.status).toBe(410)
    const paid = await invoicePayEndpoint.handler!(
      await reqAsAdmin({ ...withBody({ reference: 'TEST-REF-1' }), routeParams: { id: '00000000-0000-0000-0000-000000000000' } } as Partial<PayloadRequest>),
    )
    expect(paid.status).toBe(410)
    await expect(
      payload.create({ collection: 'invoices', data: { site: siteId.acme } as never, overrideAccess: true }),
    ).rejects.toThrow(/بایگانی|پلتفرم/)
  })

  it('reports billing integration health instead of local revenue', async () => {
    const res = await saasOverviewEndpoint.handler!(await reqAsAdmin(withUrl('http://t/api/platform/saas/overview')))
    const { overview } = await bodyOf(res)
    expect(overview.commercialAuthority).toBe('cafe-restaurant-pos')
    expect(overview.billing.commercialAuthority).toBe('cafe-restaurant-pos')
    expect(typeof overview.billing.outboxPending).toBe('number')
    expect(overview.billing.collected).toBeUndefined()
    expect(overview.subscriptions).toBeUndefined()
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

  it('refuses a commercial feature grant and records only a technical hold', async () => {
    const flag = await payload.create({
      collection: 'feature-flags',
      data: { defaultEnabled: false, key: 'test-beta-editor', label: 'ویرایشگر آزمایشی', technicallyAvailable: true },
      overrideAccess: true,
    })

    try {
      const granted = await siteFeatureEndpoint.handler!(
        await reqAsAdmin({
          ...withBody({ enabled: true, key: 'test-beta-editor', reason: 'مشتری آزمایشی' }),
          routeParams: { id: siteId.acme },
        } as Partial<PayloadRequest>),
      )
      expect(granted.status).toBe(409)

      const held = await siteFeatureEndpoint.handler!(
        await reqAsAdmin({
          ...withBody({ enabled: false, key: 'test-beta-editor', reason: 'خرابی موقت' }),
          routeParams: { id: siteId.acme },
        } as Partial<PayloadRequest>),
      )
      expect(held.status).toBe(200)

      const mine = await entitlementFor(siteId.acme)
      expect(mine.featureMap['test-beta-editor']).not.toBe(true)

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

    const text = JSON.stringify(entries)
    expect(text).not.toContain('super-secret-token')
    expect(text.toLowerCase()).not.toContain('payload_secret')
  })
})
