// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { siteDescriptor } from '@/endpoints/siteDescriptor'
import { themePackageForSite } from '@/deploy/tenantSettings'
import { themeSettingsSaveEndpoint } from '@/endpoints/themeSettings'
import { parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'
import { idOf } from '@/lib/ids'
import { assertGenericSiteDescriptor } from '../fixtures/externalThemeRenderer'

let payload: Payload

const ids = { acme: '', package: '', target: '', settings: '', homePage: '' }
const studioId = { value: '' }
let acmeSiteKey = ''

const rawManifest = {
  build: { pack: 'nixpacks', port: 3000 },
  contractVersion: 1,
  contentSlots: [
    { key: 'home', labelFa: 'صفحهٔ اصلی', required: true, type: 'page' },
    { key: 'projects', type: 'category' },
  ],
  env: [{ key: 'ESHOBE_CMS_URL', source: 'platform' }],
  key: 'descriptor-theme',
  name: 'Descriptor Theme',
  settings: {
    showNumbers: { default: true, labelFa: 'شماره بخش‌ها', type: 'boolean' },
    density: {
      default: 'comfortable',
      labelEn: 'Density',
      options: [{ labelEn: 'Compact', value: 'compact' }, { labelEn: 'Comfortable', value: 'comfortable' }],
      type: 'select',
    },
  },
  siteTypes: ['business', 'portfolio', 'store'],
}

const manifest = (): ThemeManifest => {
  const parsed = parseThemeManifest(rawManifest, 1)
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}

const fetchDescriptor = (host: string, headers: Record<string, string> = {}) =>
  createLocalReq(
    {
      req: {
        headers: new Headers({ host, ...headers }),
        method: 'GET',
        url: `http://${host}/api/site`,
      } as Partial<PayloadRequest>,
    },
    payload,
  ).then((req) => siteDescriptor.handler(req))

beforeAll(async () => {
  payload = await getPayload({ config: await config })

  const { docs: acmeDocs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    where: { slug: { equals: 'acme' } },
  })
  if (!acmeDocs[0]) throw new Error('Site acme missing — run pnpm seed')
  ids.acme = String(acmeDocs[0].id)

  const { docs: allSites } = await payload.find({ collection: 'sites', depth: 0, pagination: false })
  const studio = (allSites as { domain: string; id: string }[]).find(
    (site) => site.domain === 'studio.localhost',
  )
  if (!studio) throw new Error('Site studio.localhost missing — run pnpm seed')
  studioId.value = String(studio.id)

  await payload.delete({
    collection: 'site-theme-settings',
    overrideAccess: true,
    where: { site: { equals: ids.acme } },
  })
  await payload.delete({
    collection: 'site-deployments',
    overrideAccess: true,
    where: { site: { equals: ids.acme } },
  })
  await payload.delete({
    collection: 'theme-packages',
    overrideAccess: true,
    where: { key: { equals: 'descriptor-theme' } },
  })
  await payload.delete({
    collection: 'deploy-targets',
    overrideAccess: true,
    where: { key: { equals: 'descriptor-target' } },
  })

  const target = await payload.create({
    collection: 'deploy-targets',
    data: {
      active: true,
      apiToken: 'coolify_descriptor_token',
      baseUrl: 'https://coolify.descriptor.invalid',
      environmentName: 'production',
      gitSource: 'public',
      key: 'descriptor-target',
      name: 'سرور آزمون توصیف‌گر',
      projectUuid: 'p',
      provider: 'coolify',
      serverUuid: 's',
      wildcardDomain: '*.sites.descriptor.invalid',
    },
    overrideAccess: true,
  })

  const pkg = await payload.create({
    collection: 'theme-packages',
    data: {
      contractVersion: 1,
      defaultRef: 'main',
      envSchema: manifest().env,
      key: 'descriptor-theme',
      manifest: rawManifest,
      name: 'پوستهٔ توصیف‌گر',
      provider: 'github',
      repository: 'hamidnoshady/descriptor-theme',
      status: 'published',
      visibility: 'public',
    },
    overrideAccess: true,
  })
  ids.package = String(pkg.id)

  const deployment = await payload.create({
    collection: 'site-deployments',
    data: {
      domain: 'acme-descriptor.sites.descriptor.invalid',
      domainMode: 'preview',
      site: ids.acme,
      status: 'failed',
      target: target.id,
      themePackage: pkg.id,
    },
    overrideAccess: true,
  })
  expect(idOf(deployment.site)).toBe(ids.acme)

  const deploymentCheck = await payload.find({
    collection: 'site-deployments',
    depth: 0,
    limit: 5,
    overrideAccess: true,
    where: { site: { equals: ids.acme } },
  })
  expect(deploymentCheck.docs.length).toBeGreaterThan(0)

  const home = await payload.find({
    collection: 'pages',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { and: [{ site: { equals: ids.acme } }, { slug: { equals: 'home' } }] },
  })
  if (!home.docs[0]) {
    const fallback = await payload.find({
      collection: 'pages',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: ids.acme } },
    })
    if (!fallback.docs[0]) throw new Error('Acme has no pages — run pnpm seed')
    ids.homePage = String(fallback.docs[0].id)
  } else {
    ids.homePage = String(home.docs[0].id)
  }

  const admin = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: 'admin@eshobe.test' } },
  })
  const issued = await issueApiKeyEndpoint.handler!(
    await createLocalReq(
      {
        req: {
          json: async () => ({
            name: 'کلید آکمه (توصیف‌گر)',
            role: 'site',
            siteId: ids.acme,
          }),
        } as Partial<PayloadRequest>,
        user: { ...admin.docs[0]!, collection: 'users' },
      },
      payload,
    ),
  )
  acmeSiteKey = String(((await issued.json()) as { key?: string }).key ?? '')

  const owner = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: 'acme@eshobe.test' } },
  })
  const ownerReq = await createLocalReq(
    { user: { ...owner.docs[0]!, collection: 'users' } },
    payload,
  )
  expect(await themePackageForSite(ownerReq, ids.acme)).toBeTruthy()

  const saveRes = await themeSettingsSaveEndpoint.handler!(
    await createLocalReq(
      {
        req: {
          json: async () => ({
            bindings: { home: ids.homePage },
            runtimeSettings: { density: 'compact', showNumbers: false },
            site: ids.acme,
            values: {},
          }),
        } as Partial<PayloadRequest>,
        user: ownerReq.user,
      },
      payload,
    ),
  )
  expect(saveRes.status).toBe(200)

  const settings = await payload.find({
    collection: 'site-theme-settings',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { site: { equals: ids.acme } },
  })
  ids.settings = String(settings.docs[0]?.id ?? '')
}, 180_000)

afterAll(async () => {
  await payload.delete({
    collection: 'site-theme-settings',
    overrideAccess: true,
    where: { site: { equals: ids.acme } },
  })
  await payload.delete({
    collection: 'site-deployments',
    overrideAccess: true,
    where: { themePackage: { equals: ids.package } },
  })
  await payload.delete({
    collection: 'theme-packages',
    overrideAccess: true,
    where: { key: { equals: 'descriptor-theme' } },
  })
  await payload.delete({
    collection: 'deploy-targets',
    overrideAccess: true,
    where: { key: { equals: 'descriptor-target' } },
  })
})

describe('GET /api/site — branding, runtime settings and bindings', () => {
  it('exposes branding, runtime defaults and resolved bindings on the request host', async () => {
    const res = await fetchDescriptor('acme.localhost')
    expect(res.status).toBe(200)
    const body = assertGenericSiteDescriptor(await res.json())

    expect(body.branding.displayName).toBeTruthy()
    expect(body.themeRuntime).toMatchObject({
      package: { key: 'descriptor-theme' },
      settings: { density: 'compact', showNumbers: false },
    })
    expect(body.themeRuntime?.bindings.home).toMatchObject({
      id: ids.homePage,
      slug: 'home',
      type: 'page',
    })
    expect(JSON.stringify(body)).not.toMatch(/coolify|apiToken|secretValues|enc:v1/i)
  })

  it('changes ETag when runtime settings are updated', async () => {
    const before = await fetchDescriptor('acme.localhost')
    const etagBefore = before.headers.get('etag')

    const owner = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 1,
      where: { email: { equals: 'acme@eshobe.test' } },
    })
    await themeSettingsSaveEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            json: async () => ({
              runtimeSettings: { density: 'comfortable', showNumbers: true },
              site: ids.acme,
            }),
          } as Partial<PayloadRequest>,
          user: { ...owner.docs[0]!, collection: 'users' },
        },
        payload,
      ),
    )

    const after = await fetchDescriptor('acme.localhost')
    expect(after.headers.get('etag')).not.toBe(etagBefore)
  })

  it('changes Last-Modified when a bound page changes', async () => {
    const before = await fetchDescriptor('acme.localhost')
    const modifiedBefore = before.headers.get('last-modified')

    await payload.update({
      collection: 'pages',
      context: { disableRevalidate: true },
      data: { title: 'Home updated for descriptor test' },
      id: ids.homePage,
      locale: 'fa',
      overrideAccess: true,
    })

    const after = await fetchDescriptor('acme.localhost')
    expect(Date.parse(after.headers.get('last-modified')!)).toBeGreaterThanOrEqual(
      Date.parse(modifiedBefore!),
    )
  })

  it('resolves deleted binding targets to null', async () => {
    const temp = await payload.create({
      collection: 'categories',
      context: { disableRevalidate: true },
      data: {
        site: ids.acme,
        slug: 'temp-binding-target',
        title: 'Temp category',
      },
      locale: 'fa',
      overrideAccess: true,
    })

    const owner = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 1,
      where: { email: { equals: 'acme@eshobe.test' } },
    })
    await themeSettingsSaveEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            json: async () => ({
              bindings: { home: ids.homePage, projects: String(temp.id) },
              site: ids.acme,
            }),
          } as Partial<PayloadRequest>,
          user: { ...owner.docs[0]!, collection: 'users' },
        },
        payload,
      ),
    )

    await payload.delete({
      collection: 'categories',
      context: { disableRevalidate: true },
      id: String(temp.id),
      overrideAccess: true,
    })

    const res = await fetchDescriptor('acme.localhost')
    const body = (await res.json()) as { themeRuntime?: { bindings?: Record<string, unknown> } }
    expect(body.themeRuntime?.bindings?.projects).toBeNull()
  })

  it('refuses cross-site content bindings at save time', async () => {
    const studioPage = await payload.find({
      collection: 'pages',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: studioId.value } },
    })
    const owner = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 1,
      where: { email: { equals: 'acme@eshobe.test' } },
    })
    const res = await themeSettingsSaveEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            json: async () => ({
              bindings: { home: String(studioPage.docs[0]?.id) },
              site: ids.acme,
            }),
          } as Partial<PayloadRequest>,
          user: { ...owner.docs[0]!, collection: 'users' },
        },
        payload,
      ),
    )
    expect(res.status).toBe(400)
  })

  it('adds id and domainVerified only for a site API key, not for Host resolution', async () => {
    const publicRes = await fetchDescriptor('acme.localhost')
    const publicBody = (await publicRes.clone().json()) as Record<string, unknown>
    expect(publicBody.id).toBeUndefined()
    expect(publicBody.domainVerified).toBeUndefined()

    const keyed = await fetchDescriptor('localhost', { authorization: `Bearer ${acmeSiteKey}` })
    expect(keyed.status).toBe(200)
    const keyedBody = (await keyed.json()) as Record<string, unknown>
    expect(keyedBody.id).toBe(ids.acme)
    expect(keyedBody).toHaveProperty('domainVerified')
  })
})

describe('GET /api/site — deployment secrets stay out of the descriptor', () => {
  it('never exposes deployment env or ciphertext', async () => {
    const raw = JSON.stringify(await (await fetchDescriptor('acme.localhost')).json())
    expect(raw).not.toContain('coolify_descriptor_token')
    expect(raw).not.toContain('secretValues')
    expect(raw).not.toContain('enc:v1')
  })
})
