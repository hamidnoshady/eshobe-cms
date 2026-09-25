// @vitest-environment node
//
// Same reason as `api-keys.int.spec.ts`: `createLocalReq({ user })` builds a real
// session, and `provisioning.int.spec.ts` documents the jsdom/jose incompatibility
// this whole family of specs shares.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import {
  platformEventsEndpoint,
  platformOverviewEndpoint,
  platformSiteEndpoint,
  platformSitePatchEndpoint,
  platformSitesEndpoint,
  platformSnapshotExportEndpoint,
  platformSnapshotImportEndpoint,
} from '@/endpoints/platformControl'
import {
  accumulateOrderTotals,
  clampReportDays,
  currencyRows,
  parseSince,
  parseSitePatch,
  parseSnapshotCollections,
  snapshotCollections,
  stripSnapshotFields,
  summarizeImportPlan,
  tally,
} from '@/lib/platform-control'
import type { PlatformOverview, SiteReport } from '@/platform/report'
import type { SiteSnapshot } from '@/platform/snapshot'

/**
 * `/api/platform/*` — the surface the sibling POS's super-admin console
 * administers this whole deployment through (docs/eshobe-cms-integration.md §7).
 *
 * What this spec is actually pinning, beyond "the handlers answer":
 *
 *  - a **site** key reaches none of it, and an anonymous request reaches none of it;
 *  - a snapshot carries no `site`, so an import can never re-parent a document onto
 *    another tenant — and an import of another site's snapshot is refused outright
 *    unless it is forced;
 *  - the site patch is an allowlist, and `domain` is not in it (its one write path
 *    stays `PATCH /api/site/domain`, which resets `domainVerified`).
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

const siteId = { acme: '', shop: '' }
let platformKey = ''
let siteKey = ''

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({ collection: 'users', depth: 0, limit: 1, where: { email: { equals: email } } })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

const reqAsAdmin = async (extra?: Partial<PayloadRequest>): Promise<PayloadRequest> => {
  const admin = await userByEmail('admin@eshobe.test')
  // The fixture being an accidental platform admin is the one thing that would make
  // every assertion below pass vacuously.
  expect(admin.role).toBe('platformAdmin')
  return createLocalReq({ ...(extra ? { req: extra } : {}), user: { ...admin, collection: 'users' } }, payload)
}

const reqWithKey = (key: string, extra?: Partial<PayloadRequest>): Promise<PayloadRequest> =>
  createLocalReq(
    {
      req: {
        headers: new Headers({ authorization: `Bearer ${key}` }),
        ...extra,
      } as Partial<PayloadRequest>,
    },
    payload,
  )

const withUrl = (url: string): Partial<PayloadRequest> => ({ url } as Partial<PayloadRequest>)

const bodyOf = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>

const issueKey = async (body: Record<string, unknown>): Promise<string> => {
  const admin = await userByEmail('admin@eshobe.test')
  const req = await createLocalReq(
    { req: { json: async () => body } as Partial<PayloadRequest>, user: { ...admin, collection: 'users' } },
    payload,
  )
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
      where: { slug: { equals: slug === 'shop' ? 'shop' : 'acme' } },
    })
    if (!docs[0]) throw new Error(`Site ${slug} missing — run \`pnpm seed\``)
    siteId[slug] = String(docs[0].id)
  }
  platformKey = await issueKey({ name: 'کنسول سکو (تست)', role: 'platform' })
  siteKey = await issueKey({ name: 'سایت آکمه (تست)', role: 'site', siteId: siteId.acme })
})

describe('pure helpers', () => {
  it('clamps a report window and a cursor', () => {
    expect(clampReportDays(undefined)).toBe(30)
    expect(clampReportDays('7')).toBe(7)
    expect(clampReportDays(-4)).toBe(1)
    expect(clampReportDays(10_000)).toBe(365)

    const now = new Date('2026-09-08T12:00:00.000Z')
    // A client whose clock runs ahead must not be able to ask for an empty answer.
    expect(parseSince('2027-01-01T00:00:00.000Z', now).toISOString()).toBe(now.toISOString())
    // …and one asking for the beginning of time gets the floor, not a table scan.
    expect(parseSince('1999-01-01T00:00:00.000Z', now).toISOString()).toBe(
      new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    )
    expect(parseSince('nonsense', now).getTime()).toBeLessThan(now.getTime())
  })

  it('never adds two currencies together', () => {
    const totals = accumulateOrderTotals([
      { currency: 'IRT', total: 480_000 },
      { currency: 'IRT', total: 198_000 },
      { currency: 'IRR', total: 1_000 },
      { currency: undefined, total: 5 },
    ])
    expect(totals.IRT).toEqual({ minorTotal: 678_000, orders: 2 })
    expect(totals.IRR).toEqual({ minorTotal: 1_000, orders: 1 })
    expect(totals.unknown.orders).toBe(1)
    expect(currencyRows(totals)[0].code).toBe('IRT')
    expect(tally(['active', 'active', null])).toEqual({ active: 2, unknown: 1 })
  })

  it('allowlists the site patch and refuses the domain', () => {
    expect(parseSitePatch({ status: 'suspended' })).toEqual({ data: { status: 'suspended' }, errors: [] })
    expect(parseSitePatch({ status: 'nope' }).errors).toHaveLength(1)
    expect(parseSitePatch({}).errors).toHaveLength(1)
    // `domain` has exactly one write path (`PATCH /api/site/domain`, which resets
    // `domainVerified`); a second door here would be a second place to forget that.
    expect(parseSitePatch({ domain: 'evil.example' }).data).toEqual({})
    expect(parseSitePatch({ availableLocales: [] }).errors).toHaveLength(1)
  })

  it('strips identity from a snapshot document but keeps nested row ids', () => {
    const stripped = stripSnapshotFields({
      _status: 'published',
      createdAt: 'x',
      id: 'doc-1',
      layout: [{ blockType: 'hero', id: 'row-1' }],
      site: 'other-site',
      slug: 'about',
      updatedAt: 'y',
    })
    expect(stripped).not.toHaveProperty('site')
    expect(stripped).not.toHaveProperty('id')
    expect(stripped._status).toBe('published')
    // The block row's own id is what makes a second-locale write a translation
    // instead of a rewrite (CLAUDE.md, Payload section).
    expect((stripped.layout as { id: string }[])[0].id).toBe('row-1')
  })

  it('rejects an unknown snapshot collection instead of exporting nothing', () => {
    expect(parseSnapshotCollections('posts,products').collections).toEqual(['posts', 'products'])
    expect(parseSnapshotCollections('').collections).toEqual(snapshotCollections)
    expect(parseSnapshotCollections('postz').unknown).toEqual(['postz'])
    expect(summarizeImportPlan([
      { action: 'create', collection: 'posts', key: 'a' },
      { action: 'update', collection: 'posts', key: 'b' },
      { action: 'skip', collection: 'posts', key: 'c' },
    ])).toEqual({ created: 1, skipped: 1, updated: 1 })
  })
})

describe('who may call it', () => {
  it('refuses an anonymous request and a site key', async () => {
    for (const endpoint of [platformOverviewEndpoint, platformSitesEndpoint, platformEventsEndpoint]) {
      const anon = await endpoint.handler!(await createLocalReq({}, payload))
      expect(anon.status).toBe(403)

      const withSiteKey = await endpoint.handler!(await reqWithKey(siteKey))
      expect(withSiteKey.status, `${endpoint.path} accepted a site key`).toBe(403)
    }
  })

  it('accepts a platform key and a platform-admin session', async () => {
    expect((await platformOverviewEndpoint.handler!(await reqWithKey(platformKey))).status).toBe(200)
    expect((await platformOverviewEndpoint.handler!(await reqAsAdmin())).status).toBe(200)
  })

  it('refuses a site key on one site read, patch, export and import', async () => {
    const routeParams = { id: siteId.acme }
    const cases: [string, (req: PayloadRequest) => Promise<Response> | Response][] = [
      ['get', (req) => platformSiteEndpoint.handler!(req)],
      ['patch', (req) => platformSitePatchEndpoint.handler!(req)],
      ['export', (req) => platformSnapshotExportEndpoint.handler!(req)],
      ['import', (req) => platformSnapshotImportEndpoint.handler!(req)],
    ]
    for (const [label, call] of cases) {
      const res = await call(await reqWithKey(siteKey, { routeParams } as Partial<PayloadRequest>))
      expect(res.status, `${label} accepted a site key`).toBe(403)
    }
  })
})

describe('the fleet report', () => {
  it('counts every site, and its money per currency', async () => {
    const res = await platformOverviewEndpoint.handler!(
      await reqWithKey(platformKey, withUrl('http://cms.test/api/platform/overview?days=90')),
    )
    expect(res.status).toBe(200)
    const { overview } = (await bodyOf(res)) as { overview: PlatformOverview }

    expect(overview.sites.total).toBeGreaterThanOrEqual(3)
    expect(overview.sites.byType.store).toBeGreaterThanOrEqual(1)
    expect(overview.sites.verified + overview.sites.unverified).toBe(overview.sites.total)
    expect(overview.content.pages).toBeGreaterThan(0)
    // The seed publishes some pages and drafts others, so the two must differ —
    // a report that counted drafts as published would show them equal.
    expect(overview.content.pagesPublished).toBeLessThan(overview.content.pages)
    expect(overview.commerce.windowDays).toBe(90)
    expect(Array.isArray(overview.commerce.revenue)).toBe(true)
    expect(overview.gateways.table.length).toBeGreaterThan(0)
    // Never a credential, at any depth: the gateway table is counts and labels.
    expect(JSON.stringify(overview.gateways)).not.toMatch(/enc:v1:/)
    expect(overview.infrastructure.storage).toHaveProperty('enabled')
    expect(overview.infrastructure.jobs).toHaveProperty('queued')
  })

  it('reports one site with its own counts, and 404s an unknown id', async () => {
    const res = await platformSiteEndpoint.handler!(
      await reqWithKey(platformKey, { routeParams: { id: siteId.shop } } as Partial<PayloadRequest>),
    )
    const { site } = (await bodyOf(res)) as { site: SiteReport }
    expect(site.domain).toBe('shop.localhost')
    expect(site.totals.products).toBeGreaterThan(0)
    expect(site.currency).toBe('IRT')

    // The Customer-360 operator pane (`@/admin/SiteOverviewView`) is pure
    // composition over this exact payload, so the fields it renders are part of the
    // report's contract, not just the view's: a change that drops one of them breaks
    // the pane silently. Assert their shape here where the report is already booted.
    expect(['active', 'archived', 'suspended']).toContain(site.status)
    expect(Array.isArray(site.availableLocales)).toBe(true)
    expect(Array.isArray(site.aliases)).toBe(true)
    site.aliases.forEach((alias) => expect(typeof alias.verified).toBe('boolean'))
    expect(Array.isArray(site.gateways)).toBe(true)
    site.gateways.forEach((gateway) => {
      expect(typeof gateway.enabled).toBe('boolean')
      expect(typeof gateway.gateway).toBe('string')
      expect([null, 'failed', 'ok']).toContain(gateway.selfTest)
    })

    const missing = await platformSiteEndpoint.handler!(
      await reqWithKey(platformKey, {
        routeParams: { id: '00000000-0000-4000-8000-000000000000' },
      } as Partial<PayloadRequest>),
    )
    expect(missing.status).toBe(404)

    // Not a uuid at all: shape-checked before the query, so it is a 404 and not a
    // Postgres `invalid input syntax for type uuid` 500.
    const garbage = await platformSiteEndpoint.handler!(
      await reqWithKey(platformKey, { routeParams: { id: 'not-a-uuid' } } as Partial<PayloadRequest>),
    )
    expect(garbage.status).toBe(404)
  })

  it('lists sites paged, and filters by name', async () => {
    const res = await platformSitesEndpoint.handler!(
      await reqWithKey(platformKey, withUrl('http://cms.test/api/platform/sites?limit=2&page=1')),
    )
    const body = (await bodyOf(res)) as { sites: unknown[]; totalDocs: number }
    expect(body.sites).toHaveLength(2)
    expect(body.totalDocs).toBeGreaterThanOrEqual(3)

    const filtered = await platformSitesEndpoint.handler!(
      await reqWithKey(platformKey, withUrl('http://cms.test/api/platform/sites?q=shop.localhost')),
    )
    const found = (await bodyOf(filtered)) as { sites: { domain: string }[] }
    expect(found.sites.map((s) => s.domain)).toEqual(['shop.localhost'])
  })
})

describe('the event feed', () => {
  it('is newest-first, deduplicable by id, and carries a cursor', async () => {
    const res = await platformEventsEndpoint.handler!(
      await reqWithKey(platformKey, withUrl('http://cms.test/api/platform/events?limit=50')),
    )
    const body = (await bodyOf(res)) as {
      cursor: null | string
      events: { at: string; id: string; kind: string; level: string }[]
    }
    expect(body.events.length).toBeGreaterThan(0)
    const ids = body.events.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const times = body.events.map((e) => e.at)
    expect([...times].sort().reverse()).toEqual(times)
    // The cursor is the newest record in the page, never `now` — a record written
    // while the query ran must still be reachable on the next poll.
    expect(body.cursor).toBe(times[0])
    // Issuing the two keys above is exactly the kind of thing an operator needs to
    // find later, so it is in the feed and it stands out in a level filter.
    expect(body.events.some((e) => e.kind === 'key.issued' && e.level === 'warn')).toBe(true)
  })
})

describe('site lifecycle', () => {
  it('suspends and reactivates a site, and refuses an invalid status', async () => {
    const patch = async (body: unknown): Promise<Response> =>
      platformSitePatchEndpoint.handler!(
        await reqWithKey(platformKey, {
          json: async () => body,
          routeParams: { id: siteId.acme },
        } as unknown as Partial<PayloadRequest>),
      )

    // Mutate-and-restore on a seeded site, the same convention `api-keys.int.spec.ts`
    // uses for `acme`'s domain — and restored in a `finally`, so a failed assertion
    // does not leave a suspended fixture behind for the rest of the suite.
    try {
      const suspended = await patch({ status: 'suspended' })
      expect(suspended.status).toBe(200)
      expect(((await bodyOf(suspended)) as { site: { status: string } }).site.status).toBe('suspended')

      const bad = await patch({ status: 'melted' })
      expect(bad.status).toBe(400)
    } finally {
      const restored = await patch({ status: 'active' })
      expect(((await bodyOf(restored)) as { site: { status: string } }).site.status).toBe('active')
    }
  })

  it('refuses a defaultLocale the site does not serve, with the collection’s own message', async () => {
    const res = await platformSitePatchEndpoint.handler!(
      await reqWithKey(platformKey, {
        json: async () => ({ defaultLocale: 'en' }),
        routeParams: { id: siteId.shop },
      } as unknown as Partial<PayloadRequest>),
    )
    // `shop` is Persian-only in the seed, and `Sites` validates that its default is
    // inside its own list — so this is a 400 carrying that message, not a 500.
    expect(res.status).toBe(400)
    expect(String(((await bodyOf(res)) as { message: string }).message)).toContain('زبان')
  })
})

describe('snapshots — content in both directions', () => {
  it('exports a site’s content with no tenant identity in it', async () => {
    const res = await platformSnapshotExportEndpoint.handler!(
      await reqWithKey(platformKey, {
        routeParams: { id: siteId.acme },
        url: 'http://cms.test/api/platform/sites/x/snapshot?collections=pages,posts',
      } as Partial<PayloadRequest>),
    )
    expect(res.status).toBe(200)
    const { snapshot } = (await bodyOf(res)) as { snapshot: SiteSnapshot }

    expect(snapshot.site.id).toBe(siteId.acme)
    // `acme` is the bilingual fixture, and its default locale is written first —
    // which is the order an import has to replay.
    expect(snapshot.locales[0]).toBe('fa')
    expect(snapshot.locales).toContain('en')
    const pages = snapshot.documents.pages?.fa ?? []
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      expect(page).not.toHaveProperty('site')
      expect(page).not.toHaveProperty('id')
    }
    // Only what was asked for.
    expect(Object.keys(snapshot.documents).sort()).toEqual(['pages', 'posts'])
  })

  it('refuses another site’s snapshot, and plans a dry run of its own', async () => {
    const exported = await platformSnapshotExportEndpoint.handler!(
      await reqWithKey(platformKey, {
        routeParams: { id: siteId.acme },
        url: 'http://cms.test/api/platform/sites/x/snapshot?collections=posts',
      } as Partial<PayloadRequest>),
    )
    const { snapshot } = (await bodyOf(exported)) as { snapshot: Record<string, unknown> }

    const crossSite = await platformSnapshotImportEndpoint.handler!(
      await reqWithKey(platformKey, {
        json: async () => ({ collections: ['posts'], snapshot }),
        routeParams: { id: siteId.shop },
      } as unknown as Partial<PayloadRequest>),
    )
    // A post's hero image and categories are `acme`'s document ids; writing them onto
    // `shop` is the tenant-leak shape, so it is refused rather than attempted.
    expect(crossSite.status).toBe(409)
    expect(((await bodyOf(crossSite)) as { reason: string }).reason).toBe('site_mismatch')

    const dry = await platformSnapshotImportEndpoint.handler!(
      await reqWithKey(platformKey, {
        json: async () => ({ collections: ['posts'], dryRun: true, snapshot }),
        routeParams: { id: siteId.acme },
      } as unknown as Partial<PayloadRequest>),
    )
    expect(dry.status).toBe(200)
    const plan = (await bodyOf(dry)) as { dryRun: boolean; summary: { created: number; updated: number } }
    expect(plan.dryRun).toBe(true)
    // Re-importing a site's own snapshot is an update of every row, never a duplicate:
    // the match is `{ site, slug }`, the same key the per-site uniqueness hook uses.
    expect(plan.summary.created).toBe(0)
    expect(plan.summary.updated).toBeGreaterThan(0)
  })

  it('applies its own snapshot back without duplicating a document', async () => {
    const before = await payload.count({ collection: 'posts', where: { site: { equals: siteId.acme } } })

    const exported = await platformSnapshotExportEndpoint.handler!(
      await reqWithKey(platformKey, {
        routeParams: { id: siteId.acme },
        url: 'http://cms.test/api/platform/sites/x/snapshot?collections=posts',
      } as Partial<PayloadRequest>),
    )
    const { snapshot } = (await bodyOf(exported)) as { snapshot: Record<string, unknown> }

    const applied = await platformSnapshotImportEndpoint.handler!(
      await reqWithKey(platformKey, {
        json: async () => ({ collections: ['posts'], snapshot }),
        routeParams: { id: siteId.acme },
      } as unknown as Partial<PayloadRequest>),
    )
    expect(applied.status).toBe(200)
    const result = (await bodyOf(applied)) as { errors: unknown[]; summary: { created: number } }
    expect(result.errors).toEqual([])
    expect(result.summary.created).toBe(0)

    const after = await payload.count({ collection: 'posts', where: { site: { equals: siteId.acme } } })
    expect(after.totalDocs).toBe(before.totalDocs)
  })

  it('rejects a body with no snapshot and an unknown collection name', async () => {
    const empty = await platformSnapshotImportEndpoint.handler!(
      await reqWithKey(platformKey, {
        json: async () => ({}),
        routeParams: { id: siteId.acme },
      } as unknown as Partial<PayloadRequest>),
    )
    expect(empty.status).toBe(400)

    const typo = await platformSnapshotExportEndpoint.handler!(
      await reqWithKey(platformKey, {
        routeParams: { id: siteId.acme },
        url: 'http://cms.test/api/platform/sites/x/snapshot?collections=postz',
      } as Partial<PayloadRequest>),
    )
    expect(typo.status).toBe(400)
  })
})
