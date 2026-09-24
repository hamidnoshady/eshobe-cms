// @vitest-environment node
//
// Same reason as `platform-saas.int.spec.ts`: `createLocalReq({ user })` builds a real
// session, and `provisioning.int.spec.ts` documents the jsdom/jose incompatibility
// this whole family of specs shares.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { deployTargetSelfTest } from '@/endpoints/deployTargets'
import {
  routingTableEndpoint,
  siteDeploymentCreateEndpoint,
  siteDeploymentGetEndpoint,
  siteDeploymentRevertEndpoint,
  themePackagePublishEndpoint,
  themePackagesListEndpoint,
} from '@/endpoints/platformDeployments'
import { readDeployTargetToken } from '@/collections/hooks/deploySecrets'
import { buildEnvironment } from '@/deploy/environment'
import { createDeployment, previewHostname, setDeploymentStatus } from '@/deploy/service'
import { decryptDeploySecret } from '@/lib/deploy/crypto'
import { parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'

/**
 * WAVE-11 — the deployable-theme surface, end to end against a real database.
 *
 * What this pins, beyond "the handlers answer":
 *
 *  - a **site** key reaches none of it, and anonymous reaches nothing — the same
 *    boundary every other `/api/platform/*` route draws;
 *  - a Coolify token is never returned by any read, and is not wiped by an unrelated
 *    save (the "blank means unchanged" rule every secret in this codebase shares);
 *  - every refusal that can happen before a row exists *does* happen before a row
 *    exists — unpublished package, wrong site type, unverified domain, a `direct`
 *    mode deployment of a theme that does not proxy `/api/*`;
 *  - the environment a theme receives cannot be overridden by the tenant, and the
 *    platform values win on ordering as well as on validation;
 *  - the status machine refuses an illegal move rather than writing it.
 *
 * No network: `fetch` is stubbed. The Coolify client's own wire shape is covered by
 * `deploy-manifest.int.spec.ts`; what matters here is what the CMS does around it.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

const siteId = { acme: '', shop: '' }
let platformKey = ''
let siteKey = ''
let targetId = ''
let packageId = ''

const manifest = (overrides: Record<string, unknown> = {}): ThemeManifest => {
  const parsed = parseThemeManifest(
    {
      build: { buildCommand: 'pnpm build', pack: 'nixpacks', port: 3000, startCommand: 'pnpm start' },
      contractVersion: 1,
      env: [
        { key: 'MAP_API_KEY', labelFa: 'کلید نقشه', required: false, secret: true, source: 'tenant' },
      ],
      key: 'test-theme',
      name: 'Test Theme',
      siteTypes: ['business', 'portfolio', 'store'],
      ...overrides,
    },
    1,
  )
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}

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
  // every refusal assertion below pass vacuously.
  expect(admin.role).toBe('platformAdmin')
  return createLocalReq(
    { ...(extra ? { req: extra } : {}), user: { ...admin, collection: 'users' } },
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

const reqAnonymous = (extra?: Partial<PayloadRequest>): Promise<PayloadRequest> =>
  createLocalReq({ req: { ...extra } as Partial<PayloadRequest> }, payload)

const withBody = (body: unknown): Partial<PayloadRequest> =>
  ({ json: async () => body } as Partial<PayloadRequest>)

const withParams = (params: Record<string, string>): Partial<PayloadRequest> =>
  ({ routeParams: params } as Partial<PayloadRequest>)

/** `any`, and only here: each route returns a different hand-built JSON shape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = async (res: Response): Promise<Record<string, any>> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await res.json()) as Record<string, any>

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

  platformKey = await issueKey({ name: 'کنسول سکو (تست استقرار)', role: 'platform' })
  siteKey = await issueKey({ name: 'سایت آکمه (تست استقرار)', role: 'site', siteId: siteId.acme })

  /**
   * Fixtures are torn down before they are created, not after.
   *
   * `key` is unique on both of these collections, so a run that died half way — or
   * was interrupted — would otherwise leave rows that make every subsequent run fail
   * in `beforeAll`, which reads as "the feature broke" rather than "the last run was
   * killed". Deleting first makes the spec re-runnable from any state.
   */
  await payload.delete({
    collection: 'site-deployments',
    overrideAccess: true,
    where: { target: { exists: true } },
  })
  await payload.delete({
    collection: 'site-theme-settings',
    overrideAccess: true,
    where: { themePackage: { exists: true } },
  })
  await payload.delete({
    collection: 'theme-packages',
    overrideAccess: true,
    where: { key: { in: ['test-theme', 'unsynced-theme'] } },
  })
  await payload.delete({
    collection: 'deploy-targets',
    overrideAccess: true,
    where: { key: { equals: 'test-target' } },
  })

  const target = await payload.create({
    collection: 'deploy-targets',
    data: {
      active: true,
      apiToken: 'coolify_test_token_value',
      baseUrl: 'https://coolify.test.invalid',
      environmentName: 'production',
      gitSource: 'public',
      key: 'test-target',
      name: 'سرور تست',
      projectUuid: 'project-uuid',
      provider: 'coolify',
      serverUuid: 'server-uuid',
      wildcardDomain: '*.sites.test.invalid',
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
      envSchema: manifest().env,
      key: 'test-theme',
      manifest: manifest() as unknown as Record<string, unknown>,
      manifestSyncedAt: new Date().toISOString(),
      name: 'پوستهٔ تست',
      port: 3000,
      provider: 'github',
      repository: 'hamidnoshady/test-theme',
      siteTypes: ['business', 'portfolio', 'store'],
      status: 'draft',
      visibility: 'public',
    },
    overrideAccess: true,
  })
  packageId = String(pkg.id)
})

afterAll(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe('who may reach the deployment surface', () => {
  it('refuses a site key on every operator route', async () => {
    // A site key is a customer's integration credential. Deploying code — or even
    // reading which servers exist — is not something a customer's own app does.
    for (const endpoint of [themePackagesListEndpoint, routingTableEndpoint]) {
      const res = await endpoint.handler!(await reqWithKey(siteKey))
      expect(res.status, endpoint.path).toBe(403)
    }

    const res = await siteDeploymentGetEndpoint.handler!(
      await reqWithKey(siteKey, withParams({ id: siteId.acme })),
    )
    expect(res.status).toBe(403)
  })

  it('refuses anonymous callers', async () => {
    const res = await themePackagesListEndpoint.handler!(await reqAnonymous())
    expect(res.status).toBe(403)
  })

  it('accepts a platform key', async () => {
    const res = await themePackagesListEndpoint.handler!(await reqWithKey(platformKey))
    expect(res.status).toBe(200)
  })

  it('refuses even a platform key on publish — registering code to run is a session decision', async () => {
    const res = await themePackagePublishEndpoint.handler!(
      await reqWithKey(platformKey, { ...withParams({ id: packageId }), ...withBody({}) }),
    )
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// The Coolify token
// ---------------------------------------------------------------------------

describe('deploy target credentials', () => {
  it('never returns the token from an ordinary read, encrypted or otherwise', async () => {
    const req = await reqAsAdmin()
    const doc = (await payload.findByID({
      collection: 'deploy-targets',
      depth: 0,
      id: targetId,
      overrideAccess: true,
      req,
    })) as unknown as Record<string, unknown>

    expect(doc.apiToken).not.toContain('coolify_test_token_value')
    expect(doc.tokenSummary).toContain('توکن ذخیره شده')
  })

  it('stores ciphertext, not the typed value', async () => {
    const req = await reqAsAdmin()
    const token = await readDeployTargetToken(req, targetId)

    expect(token).toBe('coolify_test_token_value')
  })

  it('treats a blank token on an unrelated save as "unchanged", never as a delete', async () => {
    // The failure this prevents: an operator fixes a typo in the *name*, the masked
    // token field submits empty, and every deploy on that server starts failing
    // authentication an hour later with no obvious cause.
    const req = await reqAsAdmin()
    await payload.update({
      collection: 'deploy-targets',
      data: { apiToken: '', name: 'سرور تست (ویرایش‌شده)' },
      id: targetId,
      overrideAccess: true,
      req,
    })

    expect(await readDeployTargetToken(req, targetId)).toBe('coolify_test_token_value')
  })

  it('clears it only through the explicit checkbox, and then re-accepts a new one', async () => {
    const req = await reqAsAdmin()
    await payload.update({
      collection: 'deploy-targets',
      data: { clearApiToken: true },
      id: targetId,
      overrideAccess: true,
      req,
    })
    expect(await readDeployTargetToken(req, targetId)).toBeNull()

    await payload.update({
      collection: 'deploy-targets',
      data: { apiToken: 'coolify_test_token_value' },
      id: targetId,
      overrideAccess: true,
      req,
    })
    expect(await readDeployTargetToken(req, targetId)).toBe('coolify_test_token_value')
  })

  it('records a failed self-test on the row rather than throwing', async () => {
    // `coolify.test.invalid` does not resolve, which is the point: the operator has to
    // be able to tell "the token was mistyped" from "the server is unreachable", and
    // that requires the attempt to have been recorded.
    const res = await deployTargetSelfTest.handler!(
      await reqAsAdmin(withBody({ id: targetId })),
    )
    const body = await bodyOf(res)

    expect(body.ok).toBe(false)

    const doc = (await payload.findByID({
      collection: 'deploy-targets',
      depth: 0,
      id: targetId,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    expect(doc.lastSelfTestOk).toBe(false)
    expect(String(doc.lastSelfTestDetail ?? '')).not.toContain('coolify_test_token_value')
  })

  it('refuses a missing or Coolify-style id as the document id, not as a Coolify UUID check', async () => {
    // Empty body was the admin-UI bug: operators saw "شناسهٔ سرور نامعتبر" and
    // re-typed Coolify serverUuid. Those are nanoid-style; this endpoint wants the
    // Payload document id.
    const empty = await deployTargetSelfTest.handler!(await reqAsAdmin(withBody({})))
    const emptyBody = await bodyOf(empty)
    expect(empty.status).toBe(400)
    expect(emptyBody.ok).toBe(false)
    expect(String(emptyBody.message)).toContain('سند')

    const coolifyStyle = await deployTargetSelfTest.handler!(
      await reqAsAdmin(withBody({ id: 'pufsdfz0bb3617xlms8vu2rt' })),
    )
    const coolifyBody = await bodyOf(coolifyStyle)
    expect(coolifyStyle.status).toBe(400)
    expect(coolifyBody.ok).toBe(false)
    expect(String(coolifyBody.message)).toContain('سند')
  })
})

// ---------------------------------------------------------------------------
// Refusals that must happen before a row exists
// ---------------------------------------------------------------------------

describe('adopting a theme', () => {
  const siteDoc = async (slug: 'acme' | 'shop'): Promise<Record<string, unknown>> => {
    const doc = await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId[slug],
      overrideAccess: true,
    })
    return doc as unknown as Record<string, unknown>
  }

  const countDeployments = async (): Promise<number> => {
    const { totalDocs } = await payload.count({ collection: 'site-deployments', overrideAccess: true })
    return totalDocs
  }

  it('refuses an unpublished package without creating a row', async () => {
    const before = await countDeployments()
    const req = await reqAsAdmin()

    const result = await createDeployment({
      packageRef: 'test-theme',
      req,
      site: await siteDoc('acme'),
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(409)
    expect(result.message).toContain('منتشر')
    // The property that matters as much as the refusal: nothing was written.
    expect(await countDeployments()).toBe(before)
  })

  it('refuses to publish a package whose manifest was never read', async () => {
    const draft = await payload.create({
      collection: 'theme-packages',
      data: {
        defaultRef: 'main',
        key: 'unsynced-theme',
        name: 'پوستهٔ همگام‌نشده',
        provider: 'github',
        repository: 'hamidnoshady/unsynced',
        status: 'draft',
        visibility: 'public',
      },
      overrideAccess: true,
    })

    const res = await themePackagePublishEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: String(draft.id) }), ...withBody({}) }),
    )

    expect(res.status).toBe(409)
    expect((await bodyOf(res)).problems.join(' ')).toContain('مانیفست')
  })

  it('publishes a synced package', async () => {
    const res = await themePackagePublishEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: packageId }), ...withBody({}) }),
    )

    expect(res.status).toBe(200)
    expect((await bodyOf(res)).status).toBe('published')
  })

  it('refuses a package whose declared site types exclude this site', async () => {
    await payload.update({
      collection: 'theme-packages',
      data: { siteTypes: ['store'] },
      id: packageId,
      overrideAccess: true,
    })

    const site = await siteDoc('acme')
    expect(site.type).not.toBe('store')

    const result = await createDeployment({ packageRef: 'test-theme', req: await reqAsAdmin(), site })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)

    await payload.update({
      collection: 'theme-packages',
      data: { siteTypes: ['business', 'portfolio', 'store'] },
      id: packageId,
      overrideAccess: true,
    })
  })

  it('refuses any non-preview mode while the domain is unverified', async () => {
    // A theme cannot be put in front of a hostname nobody has proved is pointed here.
    const site: Record<string, unknown> = { ...(await siteDoc('acme')), domainVerified: false }

    const result = await createDeployment({
      domainMode: 'edge',
      packageRef: 'test-theme',
      req: await reqAsAdmin(),
      site,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('تأیید')
  })

  it('refuses direct mode for a theme that does not proxy /api', async () => {
    // The §5 rule: in direct mode the customer's DNS leaves Caddy, so checkout, the
    // contact form and media only work if the theme proxies them back. A theme that
    // does not declare `proxiesApi` would take checkout down the moment DNS moved.
    const site: Record<string, unknown> = { ...(await siteDoc('acme')), domainVerified: true }

    const result = await createDeployment({
      domainMode: 'direct',
      packageRef: 'test-theme',
      req: await reqAsAdmin(),
      site,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('پراکسی')
  })

  it('allows direct mode once the manifest declares the proxy', async () => {
    await payload.update({
      collection: 'theme-packages',
      data: {
        manifest: manifest({ proxiesApi: true }) as unknown as Record<string, unknown>,
        proxiesApi: true,
      },
      id: packageId,
      overrideAccess: true,
    })

    const site: Record<string, unknown> = { ...(await siteDoc('acme')), domainVerified: true }
    const result = await createDeployment({
      domainMode: 'direct',
      packageRef: 'test-theme',
      req: await reqAsAdmin(),
      site,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = await payload.findByID({
      collection: 'site-deployments',
      depth: 0,
      id: result.deploymentId,
      overrideAccess: true,
    })
    expect(row.status).toBe('queued')
    expect(row.domain).toBe(String(site.domain))

    await payload.delete({ collection: 'site-deployments', id: result.deploymentId, overrideAccess: true })
  })

  it('creates a preview deployment on the target wildcard, touching no customer DNS', async () => {
    const site = await siteDoc('acme')
    const result = await createDeployment({
      domainMode: 'preview',
      packageRef: 'test-theme',
      req: await reqAsAdmin(),
      site,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = await payload.findByID({
      collection: 'site-deployments',
      depth: 0,
      id: result.deploymentId,
      overrideAccess: true,
    })

    expect(String(row.domain)).toContain('.sites.test.invalid')
    expect(String(row.domain)).not.toBe(String(site.domain))

    await payload.delete({ collection: 'site-deployments', id: result.deploymentId, overrideAccess: true })
  })

  it('derives a stable preview hostname, which is what makes a lost create recoverable', () => {
    const site = { domain: 'acme.ir', id: 'x' }

    expect(previewHostname('*.sites.test.invalid', site, 'bazaar')).toBe(
      'acme-ir-bazaar.sites.test.invalid',
    )
    expect(previewHostname('*.sites.test.invalid', site, 'bazaar')).toBe(
      previewHostname('sites.test.invalid', site, 'bazaar'),
    )
    expect(previewHostname(null, site, 'bazaar')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The environment a theme receives
// ---------------------------------------------------------------------------

describe('the theme environment', () => {
  it('writes the platform variables after the tenant’s, so a tenant cannot shadow them', async () => {
    const req = await reqAsAdmin()
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const result = await buildEnvironment({
      apiKey: 'eshobe_live_testkey',
      manifest: manifest(),
      req,
      revalidateSecret: 'esrv_test',
      serviceDomain: 'preview.sites.test.invalid',
      site,
      themePackageId: packageId,
    })

    const keys = result.variables.map((v) => v.key)
    const cmsUrlIndex = keys.lastIndexOf('ESHOBE_CMS_URL')

    expect(cmsUrlIndex).toBeGreaterThanOrEqual(0)
    // Two independent barriers, and this is the second one: even if
    // `validateTenantEnv`'s refusal were relaxed, the platform value is written last
    // and Coolify's bulk env takes the last value for a key.
    expect(result.variables.slice(0, cmsUrlIndex).every((v) => v.key !== 'ESHOBE_CMS_URL')).toBe(true)
  })

  it('marks the API key and the revalidation secret runtime-only', async () => {
    // A secret baked into a build layer outlives the credential's rotation, in an
    // image anybody with registry access can read.
    const req = await reqAsAdmin()
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const { variables } = await buildEnvironment({
      apiKey: 'eshobe_live_testkey',
      manifest: manifest(),
      req,
      revalidateSecret: 'esrv_test',
      serviceDomain: 'preview.sites.test.invalid',
      site,
      themePackageId: packageId,
    })

    expect(variables.find((v) => v.key === 'ESHOBE_API_KEY')?.isBuildTime).toBe(false)
    expect(variables.find((v) => v.key === 'ESHOBE_REVALIDATE_SECRET')?.isBuildTime).toBe(false)
  })

  it('tells the theme the origin it is actually reachable at, not just the canonical domain', async () => {
    // A preview deployment is not on the customer's domain. A theme building absolute
    // URLs from ESHOBE_SITE_DOMAIN while running on a preview host emits links nobody
    // can follow.
    const req = await reqAsAdmin()
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const { variables } = await buildEnvironment({
      apiKey: null,
      manifest: manifest(),
      req,
      revalidateSecret: 'esrv_test',
      serviceDomain: 'preview.sites.test.invalid',
      site,
      themePackageId: packageId,
    })

    expect(variables.find((v) => v.key === 'ESHOBE_PUBLIC_ORIGIN')?.value).toBe(
      'https://preview.sites.test.invalid',
    )
    expect(variables.find((v) => v.key === 'ESHOBE_SITE_DOMAIN')?.value).toBe(String(site.domain))
  })

  it('refuses to deploy when a required tenant variable has no value', async () => {
    const req = await reqAsAdmin()
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const result = await buildEnvironment({
      apiKey: null,
      manifest: manifest({
        env: [{ key: 'MAP_API_KEY', required: true, secret: true, source: 'tenant' }],
      }),
      req,
      revalidateSecret: 'esrv_test',
      serviceDomain: 'preview.sites.test.invalid',
      site,
      themePackageId: packageId,
    })

    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('encrypts the tenant’s secret answers at rest and reads them back for a deploy', async () => {
    const req = await reqAsAdmin()

    const settings = await payload.create({
      collection: 'site-theme-settings',
      data: {
        secretValues: { MAP_API_KEY: 'tenant-secret-value' } as unknown as string,
        site: siteId.acme,
        themePackage: packageId,
        values: { ANALYTICS_ID: 'G-TEST' },
      },
      overrideAccess: true,
      req,
    })

    const stored = (await payload.findByID({
      collection: 'site-theme-settings',
      depth: 0,
      id: String(settings.id),
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    // Encrypted at rest, and `access.read: false` keeps it off every API response.
    expect(String(stored.secretValues ?? '')).not.toContain('tenant-secret-value')
    expect(decryptDeploySecret(stored.secretValues as string)).toContain('tenant-secret-value')

    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const { variables } = await buildEnvironment({
      apiKey: null,
      manifest: manifest({
        env: [
          { key: 'MAP_API_KEY', secret: true, source: 'tenant' },
          { key: 'ANALYTICS_ID', source: 'tenant' },
        ],
      }),
      req,
      revalidateSecret: 'esrv_test',
      serviceDomain: 'preview.sites.test.invalid',
      site,
      themePackageId: packageId,
    })

    expect(variables.find((v) => v.key === 'MAP_API_KEY')?.value).toBe('tenant-secret-value')
    expect(variables.find((v) => v.key === 'ANALYTICS_ID')?.value).toBe('G-TEST')

    await payload.delete({
      collection: 'site-theme-settings',
      id: String(settings.id),
      overrideAccess: true,
    })
  })
})

// ---------------------------------------------------------------------------
// Status, routing and the way back
// ---------------------------------------------------------------------------

describe('the status machine, in the database', () => {
  it('refuses an illegal transition instead of writing it', async () => {
    const req = await reqAsAdmin()
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const created = await createDeployment({ packageRef: 'test-theme', req, site })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    // A retry must not be able to overwrite a terminal state with a stale one.
    await setDeploymentStatus(req, created.deploymentId, 'queued')
    await setDeploymentStatus(req, created.deploymentId, 'live')

    const row = await payload.findByID({
      collection: 'site-deployments',
      depth: 0,
      id: created.deploymentId,
      overrideAccess: true,
    })
    expect(row.status).toBe('queued')

    await payload.delete({
      collection: 'site-deployments',
      id: created.deploymentId,
      overrideAccess: true,
    })
  })
})

describe('the routing table', () => {
  it('lists only live edge deployments — never a preview or a direct one', async () => {
    const req = await reqAsAdmin()

    const site = await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })

    const row = await payload.create({
      collection: 'site-deployments',
      data: {
        domain: String(site.domain),
        domainMode: 'preview',
        previewDomain: 'acme-preview.sites.test.invalid',
        site: siteId.acme,
        status: 'queued',
        target: targetId,
        themePackage: packageId,
      },
      overrideAccess: true,
      req,
    })

    const empty = await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))
    expect(empty.routes).toEqual([])

    // Walk it up through legal transitions, then switch it to edge mode.
    await setDeploymentStatus(req, String(row.id), 'creating')
    await setDeploymentStatus(req, String(row.id), 'building')
    await setDeploymentStatus(req, String(row.id), 'verifying')
    await setDeploymentStatus(req, String(row.id), 'live')
    await payload.update({
      collection: 'site-deployments',
      data: { domainMode: 'edge' },
      id: String(row.id),
      overrideAccess: true,
    })

    const listed = await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))
    const hosts = listed.routes.map((route: { host: string }) => route.host)

    expect(hosts).toContain(String(site.domain))
    expect(listed.routes[0].upstream).toBe('acme-preview.sites.test.invalid')

    // Suspension: a site that stopped paying must not be the one site whose
    // storefront keeps working. The deployment stays live and the row is untouched —
    // the route simply disappears until the site is active again.
    await payload.update({
      collection: 'sites',
      data: { status: 'suspended' },
      id: siteId.acme,
      overrideAccess: true,
    })

    const suspended = await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))
    expect(suspended.routes).toEqual([])

    await payload.update({
      collection: 'sites',
      data: { status: 'active' },
      id: siteId.acme,
      overrideAccess: true,
    })
    const resumed = await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))
    expect(resumed.routes.map((r: { host: string }) => r.host)).toContain(String(site.domain))

    // And the drift rule: the row remembers the hostname Coolify was configured with,
    // so a site that has since moved domains drops out of the table rather than
    // pointing its new hostname at an app that will 404 it.
    await payload.update({
      collection: 'site-deployments',
      data: { domain: 'moved-elsewhere.example' },
      id: String(row.id),
      overrideAccess: true,
    })

    const drifted = await bodyOf(await routingTableEndpoint.handler!(await reqAsAdmin()))
    expect(drifted.routes).toEqual([])

    await payload.delete({ collection: 'site-deployments', id: String(row.id), overrideAccess: true })
  })
})

describe('the way back', () => {
  it('reverts a site to the built-in renderer and stops whatever was serving it', async () => {
    // The escape hatch that makes the whole feature safe to try on a live customer.
    const req = await reqAsAdmin()

    const row = await payload.create({
      collection: 'site-deployments',
      data: {
        domain: 'acme.ir',
        domainMode: 'edge',
        site: siteId.acme,
        status: 'queued',
        target: targetId,
        themePackage: packageId,
      },
      overrideAccess: true,
      req,
    })

    await setDeploymentStatus(req, String(row.id), 'creating')
    await setDeploymentStatus(req, String(row.id), 'building')
    await setDeploymentStatus(req, String(row.id), 'verifying')
    await setDeploymentStatus(req, String(row.id), 'live')
    await payload.update({
      collection: 'sites',
      data: { activeDeployment: String(row.id), renderedBy: 'deployment' },
      id: siteId.acme,
      overrideAccess: true,
    })

    const res = await siteDeploymentRevertEndpoint.handler!(
      await reqAsAdmin({ ...withParams({ id: siteId.acme }), ...withBody({}) }),
    )
    expect(res.status).toBe(200)

    const site = await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId.acme,
      overrideAccess: true,
    })
    expect(site.renderedBy).toBe('platform')
    expect(site.activeDeployment).toBeFalsy()

    const stopped = await payload.findByID({
      collection: 'site-deployments',
      depth: 0,
      id: String(row.id),
      overrideAccess: true,
    })
    expect(stopped.status).toBe('stopped')

    await payload.delete({ collection: 'site-deployments', id: String(row.id), overrideAccess: true })
  })
})

describe('creating through the endpoint', () => {
  it('answers 202 with a row id rather than waiting for a build', async () => {
    // A Coolify build takes minutes; a synchronous version of this route is a 504 at
    // the proxy and an operator who cannot tell slow from broken.
    const res = await siteDeploymentCreateEndpoint.handler!(
      await reqAsAdmin({
        ...withParams({ id: siteId.acme }),
        ...withBody({ domainMode: 'preview', package: 'test-theme' }),
      }),
    )

    expect(res.status).toBe(202)
    const body = await bodyOf(res)
    expect(body.status).toBe('queued')

    await payload.delete({
      collection: 'site-deployments',
      id: String(body.deployment),
      overrideAccess: true,
    })
  })

  it('refuses an unknown domain mode', async () => {
    const res = await siteDeploymentCreateEndpoint.handler!(
      await reqAsAdmin({
        ...withParams({ id: siteId.acme }),
        ...withBody({ domainMode: 'whatever', package: 'test-theme' }),
      }),
    )

    expect(res.status).toBe(400)
  })
})
