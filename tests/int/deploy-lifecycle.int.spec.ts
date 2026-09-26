// @vitest-environment node
//
// Same reason as `deployments.int.spec.ts`: `createLocalReq({ user })` builds a real
// session, and jsdom's split realms break jose (see `provisioning.int.spec.ts`).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import {
  platformDeploymentEndpoints,
  routingTableEndpoint,
  siteDeploymentGetEndpoint,
  siteDeploymentRedeployEndpoint,
  siteDeploymentRollbackEndpoint,
} from '@/endpoints/platformDeployments'
import {
  flushThemeRoutesRegeneration,
  themeRoutesRegenerationPending,
} from '@/deploy/routing'
import {
  advanceDeployment,
  createDeployment,
  setDeploymentStatus,
  stopDeployment,
  verifyDeployment,
} from '@/deploy/service'
import { advanceDeployments } from '@/deploy/task'
import { parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'
import { STALE_DOMAIN_MESSAGE } from '@/lib/deploy/status'
import { getSiteByHost } from '@/lib/site-query'

/**
 * WAVE-11 — the deployment lifecycle end to end, against a real database, with only
 * the network faked: Coolify, GitHub and the health check are one `fetch` stub that
 * records every call. Everything between them — the service, the status machine, the
 * site hook, the routing table, the map file — is the real code.
 *
 * What this pins:
 *
 *  - a deploy goes queued → building → live through the queue's own step, persists
 *    `appUuid` before anything can fail, and an edge row keeps the *customer* domain
 *    (which is what the routing table matches on);
 *  - a failed redeploy leaves the live deployment and the site exactly as they were;
 *  - a redeploy re-points the reused Coolify application at the new commit, and the
 *    superseded row is stopped without stopping the application the new row runs on;
 *  - a preview never supersedes production and never moves `renderedBy`;
 *  - suspension/archival stop every application (never delete), reactivation starts
 *    nothing, and repeating a stop is safe;
 *  - a primary-domain change surfaces `needsRedeploy`, drops the route, refuses to
 *    promote a stale build, and a redeploy clears it;
 *  - the map file is regenerated after routing-affecting transitions only, and a
 *    failed regeneration fails nothing;
 *  - update-available is a commit comparison, and redeploy/rollback build the right one;
 *  - no site key reaches any deployment route.
 *
 * Uses the seeded `shop` site and restores it afterwards. Run `pnpm seed` first.
 */

let payload: Payload

const COOLIFY = 'https://coolify.lifecycle.invalid'
const WILDCARD = 'sites.lifecycle.invalid'
const SHA_MAIN = 'a'.repeat(40)
const SHA_NEXT = 'b'.repeat(40)
const SHA_PIN = 'c'.repeat(40)

type Call = { body?: Record<string, unknown>; method: string; url: string }

const net = {
  apps: [] as { name: string; uuid: string }[],
  buildStatus: 'finished',
  calls: [] as Call[],
  counter: 0,
  healthStatus: 200,
  refs: { main: SHA_MAIN } as Record<string, string>,
  stopFails: false,
}

const respond = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' }, status })

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = String(init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
  net.calls.push({ body, method, url })

  if (url.startsWith(`${COOLIFY}/api/v1`)) {
    const path = url.slice(`${COOLIFY}/api/v1`.length)
    if (method === 'GET' && path === '/applications') return respond(net.apps)
    if (method === 'POST' && path.startsWith('/applications/')) {
      const uuid = `app-${++net.counter}`
      net.apps.push({ name: String(body?.name ?? ''), uuid })
      return respond({ uuid })
    }
    if (method === 'PATCH' && /^\/applications\/[^/]+\/envs\/bulk$/.test(path)) return respond({})
    if (method === 'PATCH' && /^\/applications\/[^/]+$/.test(path)) return respond({})
    if (method === 'GET' && path.startsWith('/deploy?uuid=')) {
      return respond({ deployments: [{ deployment_uuid: `build-${++net.counter}` }] })
    }
    if (method === 'GET' && path.startsWith('/deployments/')) return respond({ status: net.buildStatus })
    if (method === 'GET' && path.endsWith('/stop')) {
      return net.stopFails ? respond({ message: 'coolify is down' }, 502) : respond({})
    }
    if (method === 'GET' && path.endsWith('/start')) return respond({})
    if (method === 'DELETE') return respond({})
    return respond({ message: 'not stubbed' }, 404)
  }

  if (url.startsWith('https://api.github.com/repos/')) {
    const ref = decodeURIComponent(url.split('/commits/')[1] ?? '')
    return net.refs[ref] ? respond({ sha: net.refs[ref] }) : respond({ message: 'Not Found' }, 404)
  }

  if (url.includes(`.${WILDCARD}`)) return new Response('ok', { status: net.healthStatus })

  return new Response('not stubbed', { status: 404 })
}

const callsTo = (method: string, pattern: RegExp): Call[] =>
  net.calls.filter((call) => call.method === method && pattern.test(call.url))

let siteId = ''
let original: Record<string, unknown> = {}
let targetId = ''
let packageId = ''
let siteKey = ''

const rawManifest = (overrides: Record<string, unknown> = {}) => ({
  build: { buildCommand: 'pnpm build', healthCheckPath: '/health', pack: 'nixpacks', port: 3000 },
  contractVersion: 1,
  key: 'lifecycle-theme',
  name: 'Lifecycle Theme',
  proxiesApi: true,
  siteTypes: ['business', 'portfolio', 'store'],
  ...overrides,
})

const manifest = (overrides: Record<string, unknown> = {}): ThemeManifest => {
  const parsed = parseThemeManifest(rawManifest(overrides), 1)
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({ collection: 'users', depth: 0, limit: 1, where: { email: { equals: email } } })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

const reqAsAdmin = async (extra?: Partial<PayloadRequest>): Promise<PayloadRequest> => {
  const admin = await userByEmail('admin@eshobe.test')
  expect(admin.role).toBe('platformAdmin')
  return createLocalReq({ ...(extra ? { req: extra } : {}), user: { ...admin, collection: 'users' } }, payload)
}

const reqWithKey = (key: string, extra?: Partial<PayloadRequest>): Promise<PayloadRequest> =>
  createLocalReq(
    { req: { headers: new Headers({ authorization: `Bearer ${key}` }), ...extra } as Partial<PayloadRequest> },
    payload,
  )

const withBody = (body: unknown): Partial<PayloadRequest> => ({ json: async () => body }) as Partial<PayloadRequest>
const withParams = (params: Record<string, string>): Partial<PayloadRequest> =>
  ({ routeParams: params }) as Partial<PayloadRequest>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = async (res: Response): Promise<Record<string, any>> => (await res.json()) as Record<string, any>

const site = async (): Promise<Record<string, unknown>> =>
  (await payload.findByID({ collection: 'sites', depth: 0, id: siteId, overrideAccess: true })) as unknown as Record<
    string,
    unknown
  >

const row = async (id: string): Promise<Record<string, unknown>> =>
  (await payload.findByID({ collection: 'site-deployments', depth: 0, id, overrideAccess: true })) as unknown as Record<
    string,
    unknown
  >

const updateSite = (data: Record<string, unknown>) =>
  payload.update({ collection: 'sites', data, id: siteId, overrideAccess: true })

const resetSite = async () => {
  await payload.delete({ collection: 'site-deployments', overrideAccess: true, where: { site: { equals: siteId } } })
  // Two writes: a changed domain resets verification in the same save.
  await updateSite({ activeDeployment: null, domain: String(original.domain), renderedBy: 'platform', status: 'active' })
  await updateSite({ domainVerified: true })
}

/** Create a deployment and walk it through the queue's own steps until it is live. */
const deployToLive = async (domainMode: 'direct' | 'edge' | 'preview', ref?: string): Promise<string> => {
  const req = await reqAsAdmin()
  const created = await createDeployment({ domainMode, packageRef: packageId, ref, req, site: await site() })
  if (!created.ok) throw new Error(created.message)
  await advanceDeployment(req, created.deploymentId)
  await advanceDeployment(req, created.deploymentId)
  return created.deploymentId
}

const getDeployment = async () =>
  bodyOf(await siteDeploymentGetEndpoint.handler!(await reqAsAdmin(withParams({ id: siteId }))))

beforeAll(async () => {
  payload = await getPayload({ config })
  vi.stubGlobal('fetch', fakeFetch)

  const { docs } = await payload.find({ collection: 'sites', depth: 0, limit: 1, where: { slug: { equals: 'shop' } } })
  if (!docs[0]) throw new Error('Site shop missing — run `pnpm seed`')
  siteId = String(docs[0].id)
  original = { ...(docs[0] as unknown as Record<string, unknown>) }

  // Re-runnable from any state, like the sibling spec.
  await payload.delete({ collection: 'site-deployments', overrideAccess: true, where: { site: { equals: siteId } } })
  await payload.delete({ collection: 'theme-packages', overrideAccess: true, where: { key: { equals: 'lifecycle-theme' } } })
  await payload.delete({ collection: 'deploy-targets', overrideAccess: true, where: { key: { equals: 'lifecycle-target' } } })

  const target = await payload.create({
    collection: 'deploy-targets',
    data: {
      active: true,
      apiToken: 'coolify_lifecycle_token',
      baseUrl: COOLIFY,
      environmentName: 'production',
      gitSource: 'public',
      key: 'lifecycle-target',
      name: 'سرور چرخهٔ عمر',
      projectUuid: 'project-uuid',
      provider: 'coolify',
      serverUuid: 'server-uuid',
      wildcardDomain: `*.${WILDCARD}`,
    },
    overrideAccess: true,
  })
  targetId = String(target.id)

  const pkg = await payload.create({
    collection: 'theme-packages',
    data: {
      buildPack: 'nixpacks',
      contractVersion: 1,
      defaultRef: 'main',
      defaultTarget: targetId,
      envSchema: [],
      healthCheckPath: '/health',
      key: 'lifecycle-theme',
      manifest: rawManifest(),
      manifestSyncedAt: new Date().toISOString(),
      name: 'پوستهٔ چرخهٔ عمر',
      port: 3000,
      provider: 'github',
      proxiesApi: true,
      repository: 'hamidnoshady/lifecycle-theme',
      siteTypes: ['business', 'portfolio', 'store'],
      status: 'published',
      syncedCommitSha: SHA_MAIN,
      visibility: 'public',
    },
    overrideAccess: true,
  })
  packageId = String(pkg.id)

  const issued = await issueApiKeyEndpoint.handler!(
    await reqAsAdmin(withBody({ name: 'کلید سایت فروشگاه (تست چرخه)', role: 'site', siteId })),
  )
  siteKey = String(((await issued.json()) as { key?: string }).key ?? '')
  if (!siteKey) throw new Error('site key issue failed')

  await resetSite()
})

beforeEach(async () => {
  net.apps = []
  net.buildStatus = 'finished'
  net.calls = []
  net.counter = 0
  net.healthStatus = 200
  net.refs = { main: SHA_MAIN }
  net.stopFails = false
  await flushThemeRoutesRegeneration()
  delete process.env.THEME_ROUTES_FILE
  await payload.update({
    collection: 'theme-packages',
    context: { eshobeThemePackageSync: true },
    data: { defaultRef: 'main', pinnedCommit: null, syncedCommitSha: SHA_MAIN },
    id: packageId,
    overrideAccess: true,
  })
  await resetSite()
})

afterAll(async () => {
  await flushThemeRoutesRegeneration()
  delete process.env.THEME_ROUTES_FILE
  vi.unstubAllGlobals()
  await payload.delete({ collection: 'site-deployments', overrideAccess: true, where: { site: { equals: siteId } } })
  await updateSite({ activeDeployment: null, domain: original.domain, renderedBy: 'platform', status: original.status })
  await updateSite({ domainVerified: original.domainVerified })
  await payload.delete({ collection: 'theme-packages', overrideAccess: true, where: { key: { equals: 'lifecycle-theme' } } })
  await payload.delete({ collection: 'deploy-targets', overrideAccess: true, where: { key: { equals: 'lifecycle-target' } } })
})

// ---------------------------------------------------------------------------
// The boundary, for the whole family
// ---------------------------------------------------------------------------

describe('who may reach the deployment routes', () => {
  it('refuses a site key and an anonymous caller on every deployment route, redeploy included', async () => {
    expect(platformDeploymentEndpoints).toContain(siteDeploymentRedeployEndpoint)

    for (const endpoint of platformDeploymentEndpoints) {
      const asSite = await endpoint.handler!(
        await reqWithKey(siteKey, { ...withParams({ id: siteId }), ...withBody({ package: packageId }) }),
      )
      expect(asSite.status, `${endpoint.method} ${endpoint.path} with a site key`).toBe(403)

      const anonymous = await endpoint.handler!(
        await createLocalReq({ req: { ...withParams({ id: siteId }), ...withBody({}) } as Partial<PayloadRequest> }, payload),
      )
      expect(anonymous.status, `${endpoint.method} ${endpoint.path} anonymously`).toBe(403)
    }

    // Nothing was created by any of those attempts.
    const { totalDocs } = await payload.count({ collection: 'site-deployments', where: { site: { equals: siteId } } })
    expect(totalDocs).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// A deploy, through the queue
// ---------------------------------------------------------------------------

describe('an edge deployment, from queued to live', () => {
  it('runs in the queue, persists appUuid, keeps the customer domain and flips the site only once healthy', async () => {
    const req = await reqAsAdmin()
    const shop = await site()
    const created = await createDeployment({ domainMode: 'edge', packageRef: packageId, req, site: shop })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // Creating is fast and does no network work.
    expect(net.calls).toHaveLength(0)
    expect((await row(created.deploymentId)).status).toBe('queued')

    // The queue task picks it up.
    await advanceDeployments(req)
    const building = await row(created.deploymentId)
    expect(building.status).toBe('building')
    expect(building.appUuid).toBe('app-1')
    expect(building.commitSha).toBe(SHA_MAIN)
    // The row describes the customer's hostname; Caddy's upstream is the preview one.
    expect(building.domain).toBe(String(shop.domain))
    expect(String(building.previewDomain)).toMatch(new RegExp(`\\.${WILDCARD.replace(/\./g, '\\.')}$`))
    expect(String(building.previewDomain)).not.toContain('-preview.')

    // In edge mode the application must not claim the customer's domain in Coolify.
    const create = callsTo('POST', /\/applications\/public$/)[0]!
    expect(String(create.body?.domains)).toBe(`https://${String(building.previewDomain)}`)
    expect(create.body?.is_auto_deploy_enabled).toBe(false)

    // The theme builds links from its public origin, which in edge mode is the
    // customer's domain (Caddy proxies it) — not the preview name it answers on.
    const env = callsTo('PATCH', /\/envs\/bulk$/)[0]!
    const vars = (env.body?.data ?? []) as { key: string; value: string }[]
    expect(vars.find((v) => v.key === 'ESHOBE_PUBLIC_ORIGIN')?.value).toBe(`https://${String(shop.domain)}`)
    expect(vars.find((v) => v.key === 'ESHOBE_SITE_DOMAIN')?.value).toBe(String(shop.domain))

    // Not live yet: the site is untouched until the health check answers.
    expect((await site()).renderedBy).toBe('platform')

    await advanceDeployments(req)
    const live = await row(created.deploymentId)
    expect(live.status).toBe('live')
    // The health check went to the application itself, not the customer domain.
    expect(callsTo('GET', new RegExp(`^https://${String(building.previewDomain)}/health$`))).toHaveLength(1)

    const after = await site()
    expect(after.renderedBy).toBe('deployment')
    expect(after.activeDeployment).toBe(created.deploymentId)

    const routes = await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))
    expect(routes.routes).toContainEqual({ host: String(shop.domain), upstream: String(building.previewDomain) })
  })

  it('keeps renderedBy/activeDeployment out of reach of a stale admin form', async () => {
    const liveId = await deployToLive('edge')
    // A platform admin's form opened before the deploy went live, saved afterwards.
    await payload.update({
      collection: 'sites',
      data: { activeDeployment: null, name: String(original.name), renderedBy: 'platform' },
      id: siteId,
      overrideAccess: false,
      user: await userByEmail('admin@eshobe.test'),
    })
    const after = await site()
    expect(after.renderedBy).toBe('deployment')
    expect(after.activeDeployment).toBe(liveId)
  })

  it('persists appUuid before a later step can fail', async () => {
    const req = await reqAsAdmin()
    const created = await createDeployment({ domainMode: 'edge', packageRef: packageId, req, site: await site() })
    if (!created.ok) throw new Error(created.message)

    // Coolify accepts the create, then refuses the environment write.
    const refuseEnv = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/\/envs\/bulk$/.test(url)) return respond({ message: 'env write refused' }, 500)
      return fakeFetch(input, init)
    }
    vi.stubGlobal('fetch', refuseEnv)
    try {
      await advanceDeployment(req, created.deploymentId)
    } finally {
      vi.stubGlobal('fetch', fakeFetch)
    }

    const failed = await row(created.deploymentId)
    expect(failed.status).toBe('failed')
    expect(failed.appUuid).toBe('app-1')
    expect((await site()).renderedBy).toBe('platform')
  })

  it('refuses to run a queued deployment for a site that was suspended meanwhile', async () => {
    const req = await reqAsAdmin()
    const created = await createDeployment({ domainMode: 'preview', packageRef: packageId, req, site: await site() })
    if (!created.ok) throw new Error(created.message)

    // Suspension stops the queued row outright — it never reaches Coolify.
    await updateSite({ status: 'suspended' })
    await advanceDeployment(req, created.deploymentId)

    expect((await row(created.deploymentId)).status).toBe('stopped')
    expect(callsTo('POST', /\/applications\//)).toHaveLength(0)
  })
})

describe('redeploy, upgrade and rollback', () => {
  it('a failed redeploy leaves the live deployment and the site exactly as they were', async () => {
    const liveId = await deployToLive('edge')
    net.buildStatus = 'failed'

    const res = await siteDeploymentRedeployEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({}) }),
    )
    expect(res.status).toBe(202)
    const { deployment } = await bodyOf(res)

    const req = await reqAsAdmin()
    await advanceDeployment(req, deployment)
    await advanceDeployment(req, deployment)

    expect((await row(deployment)).status).toBe('failed')
    expect((await row(liveId)).status).toBe('live')
    const after = await site()
    expect(after.renderedBy).toBe('deployment')
    expect(after.activeDeployment).toBe(liveId)
    // Nothing was stopped and nothing was deleted.
    expect(callsTo('GET', /\/stop$/)).toHaveLength(0)
    expect(net.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
  })

  it('surfaces a new synced version, and redeploy builds it on the reused application', async () => {
    const liveId = await deployToLive('edge')

    expect((await getDeployment()).update).toMatchObject({
      deployedCommit: SHA_MAIN,
      latestCommit: SHA_MAIN,
      updateAvailable: false,
    })

    // A sync resolved `main` to a newer commit.
    net.refs.main = SHA_NEXT
    await payload.update({
      collection: 'theme-packages',
      context: { eshobeThemePackageSync: true },
      data: { syncedCommitSha: SHA_NEXT },
      id: packageId,
      overrideAccess: true,
    })

    const status = await getDeployment()
    expect(status.update).toMatchObject({
      deployedCommit: SHA_MAIN,
      latestCommit: SHA_NEXT,
      packageRef: 'main',
      updateAvailable: true,
    })
    // Nothing about another site's packages or secrets rides along.
    expect(JSON.stringify(status)).not.toMatch(/enc:|revalidateSecret|apiToken|eshobe_live_/)

    const res = await siteDeploymentRedeployEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({}) }),
    )
    const { deployment, domainMode, ref } = await bodyOf(res)
    expect(res.status).toBe(202)
    expect(domainMode).toBe('edge')
    expect(ref).toBe('main')

    net.calls = []
    const req = await reqAsAdmin()
    await advanceDeployment(req, deployment)

    // Same application (deterministic name), re-pointed at the new commit before the build.
    const fresh = await row(deployment)
    expect(fresh.appUuid).toBe('app-1')
    expect(fresh.commitSha).toBe(SHA_NEXT)
    expect(callsTo('POST', /\/applications\//)).toHaveLength(0)
    const repoint = callsTo('PATCH', /\/applications\/app-1$/)[0]
    expect(repoint?.body).toMatchObject({ git_branch: 'main', git_commit_sha: SHA_NEXT })

    await advanceDeployment(req, deployment)
    expect((await row(deployment)).status).toBe('live')

    // The old row is history now — but its application is the new row's application,
    // so it must not have been stopped.
    const superseded = await row(liveId)
    expect(superseded.status).toBe('stopped')
    expect(callsTo('GET', /\/applications\/app-1\/stop$/)).toHaveLength(0)

    // Its key is revoked; the new row has its own.
    const oldKey = await payload.findByID({ collection: 'api-keys', id: String(superseded.apiKey), overrideAccess: true })
    expect(oldKey.disabledAt).toBeTruthy()
    expect(String(fresh.apiKey)).not.toBe(String(superseded.apiKey))

    expect((await getDeployment()).update.updateAvailable).toBe(false)
  })

  it('treats a pin as the package’s version, and a rollback beats the pin', async () => {
    const liveId = await deployToLive('edge')

    await payload.update({ collection: 'theme-packages', data: { pinnedCommit: SHA_PIN }, id: packageId, overrideAccess: true })
    expect((await getDeployment()).update).toMatchObject({ latestCommit: SHA_PIN, updateAvailable: true })

    // Rolling back to the commit the live row runs must build *that* commit, not the pin.
    const res = await siteDeploymentRollbackEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({ deployment: liveId }) }),
    )
    expect(res.status).toBe(202)
    const { deployment } = await bodyOf(res)

    await advanceDeployment(await reqAsAdmin(), deployment)
    const rolled = await row(deployment)
    expect(rolled.ref).toBe(SHA_MAIN)
    expect(rolled.commitSha).toBe(SHA_MAIN)
    // A sha is not a branch: Coolify clones the default branch and checks the commit out.
    const repoint = callsTo('PATCH', /\/applications\/app-1$/).at(-1)
    expect(repoint?.body).toMatchObject({ git_branch: 'main', git_commit_sha: SHA_MAIN })

    await payload.update({ collection: 'theme-packages', data: { pinnedCommit: null }, id: packageId, overrideAccess: true })
  })

  it('withholds the notice when the package was never synced, and forgets a sync when the ref is edited', async () => {
    await deployToLive('edge')

    await payload.update({ collection: 'theme-packages', data: { defaultRef: 'develop' }, id: packageId, overrideAccess: true })
    const pkg = await payload.findByID({ collection: 'theme-packages', id: packageId, overrideAccess: true })
    expect(pkg.syncedCommitSha).toBeFalsy()
    expect((await getDeployment()).update).toMatchObject({ latestCommit: null, updateAvailable: false })

    await payload.update({
      collection: 'theme-packages',
      context: { eshobeThemePackageSync: true },
      data: { defaultRef: 'main', syncedCommitSha: SHA_MAIN },
      id: packageId,
      overrideAccess: true,
    })
  })

  it('answers 409 when there is nothing to redeploy, and 400 for a bad ref', async () => {
    const none = await siteDeploymentRedeployEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({}) }),
    )
    expect(none.status).toBe(409)

    const bad = await siteDeploymentRedeployEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({ ref: '../../etc' }) }),
    )
    expect(bad.status).toBe(400)
  })

  it('takes package, repository and target from the source row, never from the body', async () => {
    const liveId = await deployToLive('edge')
    const res = await siteDeploymentRedeployEndpoint.handler!(
      await reqAsAdmin({
        ...withParams({ id: siteId }),
        ...withBody({ package: 'something-else', repository: 'evil/repo', target: 'elsewhere' }),
      }),
    )
    expect(res.status).toBe(202)
    const fresh = await row((await bodyOf(res)).deployment)
    const source = await row(liveId)
    expect(fresh.themePackage).toBe(source.themePackage)
    expect(fresh.target).toBe(source.target)
  })
})

describe('a preview is a rehearsal', () => {
  it('never supersedes production, never moves renderedBy, and runs on its own application', async () => {
    const productionId = await deployToLive('edge')
    const previewId = await deployToLive('preview')

    expect((await row(previewId)).status).toBe('live')
    expect((await row(productionId)).status).toBe('live')

    const preview = await row(previewId)
    expect(String(preview.domain)).toContain('-preview.')
    expect(preview.appUuid).not.toBe((await row(productionId)).appUuid)

    const after = await site()
    expect(after.renderedBy).toBe('deployment')
    expect(after.activeDeployment).toBe(productionId)
    expect(callsTo('GET', /\/stop$/)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Site lifecycle
// ---------------------------------------------------------------------------

describe('suspension and archival', () => {
  it('suspending stops a live edge deployment — application kept, key revoked, route gone', async () => {
    const liveId = await deployToLive('edge')
    const before = await row(liveId)

    await updateSite({ status: 'suspended' })

    const stopped = await row(liveId)
    expect(stopped.status).toBe('stopped')
    expect(callsTo('GET', new RegExp(`/applications/${String(before.appUuid)}/stop$`))).toHaveLength(1)
    expect(net.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
    const key = await payload.findByID({ collection: 'api-keys', id: String(before.apiKey), overrideAccess: true })
    expect(key.disabledAt).toBeTruthy()

    const after = await site()
    expect(after.status).toBe('suspended')
    expect(after.renderedBy).toBe('platform')
    expect(after.activeDeployment).toBeFalsy()
    expect((await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))).routes).toEqual([])
  })

  it('suspending stops a live direct deployment too — its DNS never passed through Caddy', async () => {
    const liveId = await deployToLive('direct')
    expect(callsTo('POST', /\/applications\/public$/)[0]?.body?.domains).toContain(`https://${String(original.domain)}`)

    // The health check reached the application on its own hostname: the customer's
    // domain may still point at Caddy, whose built-in renderer would answer 200.
    const preview = String((await row(liveId)).previewDomain)
    expect(callsTo('GET', new RegExp(`^https://${preview}/health$`))).toHaveLength(1)
    expect(callsTo('GET', new RegExp(`^https://${String(original.domain)}/`))).toHaveLength(0)

    await updateSite({ status: 'suspended' })

    expect((await row(liveId)).status).toBe('stopped')
    expect(callsTo('GET', /\/applications\/app-1\/stop$/)).toHaveLength(1)
    expect((await site()).renderedBy).toBe('platform')
  })

  it('archiving stops live, preview and queued deployments alike', async () => {
    const liveId = await deployToLive('edge')
    const previewId = await deployToLive('preview')
    const req = await reqAsAdmin()
    const queued = await createDeployment({ domainMode: 'edge', packageRef: packageId, req, site: await site() })
    if (!queued.ok) throw new Error(queued.message)

    await updateSite({ status: 'archived' })

    for (const id of [liveId, previewId, queued.deploymentId]) expect((await row(id)).status).toBe('stopped')
    // Two applications (production and preview), each stopped once; the queued row had none.
    expect(callsTo('GET', /\/stop$/)).toHaveLength(2)
  })

  it('reactivating restarts nothing, and a second suspension is harmless', async () => {
    const liveId = await deployToLive('edge')
    await updateSite({ status: 'suspended' })
    net.calls = []

    await updateSite({ status: 'active' })
    expect((await row(liveId)).status).toBe('stopped')
    expect((await site()).renderedBy).toBe('platform')
    expect(callsTo('GET', /\/(start|deploy\?)/)).toHaveLength(0)
    const { totalDocs: queued } = await payload.count({
      collection: 'site-deployments',
      where: { and: [{ site: { equals: siteId } }, { status: { equals: 'queued' } }] },
    })
    expect(queued).toBe(0)

    await updateSite({ status: 'suspended' })
    expect((await row(liveId)).status).toBe('stopped')

    // Stopping an already stopped row again only repeats the Coolify stop.
    const again = await stopDeployment(await reqAsAdmin(), liveId, 'دوباره')
    expect(again.ok).toBe(true)
    expect((await row(liveId)).status).toBe('stopped')
  })

  it('a Coolify outage does not block the suspension; the row says so and a retry works', async () => {
    const liveId = await deployToLive('edge')
    net.stopFails = true

    await updateSite({ status: 'suspended' })

    expect((await site()).status).toBe('suspended')
    const stopped = await row(liveId)
    expect(stopped.status).toBe('stopped')
    expect(String(stopped.lastError)).toContain('Coolify')

    net.stopFails = false
    const retry = await stopDeployment(await reqAsAdmin(), liveId, 'تلاش دوباره')
    expect(retry.applicationStopped).toBe(true)
  })

  it('hands the domain back to the built-in renderer, which answers with the holding page', async () => {
    await deployToLive('edge')
    await updateSite({ status: 'suspended' })

    // No theme route for the host, so Caddy sends it to web:3000; there the site still
    // resolves (a holding page, not a 404) and is not `serving` (`getSiteContext`).
    expect((await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))).routes).toEqual([])
    const resolved = await getSiteByHost(String(original.domain))
    expect(resolved?.id).toBe(siteId)
    expect(resolved?.status).toBe('suspended')
    expect((await site()).renderedBy).toBe('platform')
  })
})

// ---------------------------------------------------------------------------
// Primary domain changes
// ---------------------------------------------------------------------------

describe('a primary-domain change after a production deployment', () => {
  const newDomain = 'shop-moved.localhost'

  for (const mode of ['edge', 'direct'] as const) {
    it(`${mode}: reports needsRedeploy, drops the route, and a redeploy on the verified new domain clears it`, async () => {
      const liveId = await deployToLive(mode)
      expect((await getDeployment()).needsRedeploy).toBe(false)

      await updateSite({ domain: newDomain })
      expect((await site()).domainVerified).toBe(false)

      const status = await getDeployment()
      expect(status.needsRedeploy).toBe(true)
      expect(status.current.id).toBe(liveId)
      expect(status.current.attention).toBe(STALE_DOMAIN_MESSAGE)
      // The deployment ran fine; this is not a failure.
      expect(status.current.status).toBe('live')
      expect((await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))).routes).toEqual([])

      // Not before the new domain is verified.
      const early = await siteDeploymentRedeployEndpoint.handler!(
        await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({}) }),
      )
      expect(early.status).toBe(409)

      await updateSite({ domainVerified: true })
      const res = await siteDeploymentRedeployEndpoint.handler!(
        await reqAsAdmin({ ...withParams({ id: siteId }), ...withBody({}) }),
      )
      expect(res.status).toBe(202)
      const { deployment } = await bodyOf(res)
      const req = await reqAsAdmin()
      await advanceDeployment(req, deployment)
      expect((await row(deployment)).domain).toBe(newDomain)
      await advanceDeployment(req, deployment)
      expect((await row(deployment)).status).toBe('live')

      const cleared = await getDeployment()
      expect(cleared.needsRedeploy).toBe(false)
      expect((await row(liveId)).status).toBe('stopped')
    })
  }

  it('refuses to promote a build made for the previous domain', async () => {
    const req = await reqAsAdmin()
    const created = await createDeployment({ domainMode: 'edge', packageRef: packageId, req, site: await site() })
    if (!created.ok) throw new Error(created.message)
    await advanceDeployment(req, created.deploymentId)
    expect((await row(created.deploymentId)).status).toBe('building')

    // The domain moves (and is re-verified) while the build runs.
    await updateSite({ domain: newDomain })
    await updateSite({ domainVerified: true })
    await setDeploymentStatus(req, created.deploymentId, 'verifying')

    const verified = await verifyDeployment(req, created.deploymentId)
    expect(verified.ok).toBe(false)
    expect(verified.message).toBe(STALE_DOMAIN_MESSAGE)
    expect((await row(created.deploymentId)).status).toBe('failed')
    expect((await site()).renderedBy).toBe('platform')
  })

  it('leaves a preview alone', async () => {
    const previewId = await deployToLive('preview')
    await updateSite({ domain: newDomain })
    const status = await getDeployment()
    expect(status.needsRedeploy).toBe(false)
    expect((await row(previewId)).status).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// The map file
// ---------------------------------------------------------------------------

describe('theme-routes.caddy regeneration', () => {
  let dir = ''
  let file = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'theme-routes-'))
    file = join(dir, 'theme-routes.caddy')
    writeFileSync(file, 'map {host} {theme_upstream} {\n\tdefault ""\n}\n')
    process.env.THEME_ROUTES_FILE = file
  })

  afterAll(() => {
    if (dir) rmSync(dir, { force: true, recursive: true })
  })

  it('is requested when an edge deployment goes live and when it stops', async () => {
    const liveId = await deployToLive('edge')
    expect(themeRoutesRegenerationPending()).toBe(true)
    const written = await flushThemeRoutesRegeneration()
    expect(written).toMatchObject({ count: 1, outcome: 'written' })

    const preview = String((await row(liveId)).previewDomain)
    expect(readFileSync(file, 'utf8')).toContain(`\t${String(original.domain)} ${preview}`)

    await stopDeployment(await reqAsAdmin(), liveId, 'توقف دستی')
    expect(themeRoutesRegenerationPending()).toBe(true)
    await flushThemeRoutesRegeneration()
    expect(readFileSync(file, 'utf8')).not.toContain(String(original.domain))
  })

  it('is requested by suspension and by a domain change', async () => {
    await deployToLive('edge')
    await flushThemeRoutesRegeneration()

    await updateSite({ domain: 'shop-moved.localhost' })
    expect(themeRoutesRegenerationPending()).toBe(true)
    await flushThemeRoutesRegeneration()
    expect(readFileSync(file, 'utf8')).not.toContain(String(original.domain))
  })

  it('is not requested for transitions that cannot change the map', async () => {
    const previewId = await deployToLive('preview')
    expect(themeRoutesRegenerationPending()).toBe(false)
    await stopDeployment(await reqAsAdmin(), previewId, 'توقف')
    expect(themeRoutesRegenerationPending()).toBe(false)
    // An unrelated edit to a site with no deployed theme.
    await updateSite({ name: String(original.name) })
    expect(themeRoutesRegenerationPending()).toBe(false)
  })

  it('a failed regeneration fails nothing and leaves the previous map in place', async () => {
    process.env.THEME_ROUTES_FILE = join(dir, 'missing-directory', 'theme-routes.caddy')
    const liveId = await deployToLive('edge')
    const result = await flushThemeRoutesRegeneration()
    expect(result).toBeNull()
    expect((await row(liveId)).status).toBe('live')
    expect(readFileSync(file, 'utf8')).toBe('map {host} {theme_upstream} {\n\tdefault ""\n}\n')
  })

  it('does nothing at all when this process does not own the map', async () => {
    delete process.env.THEME_ROUTES_FILE
    await deployToLive('edge')
    expect(themeRoutesRegenerationPending()).toBe(false)
  })
})
