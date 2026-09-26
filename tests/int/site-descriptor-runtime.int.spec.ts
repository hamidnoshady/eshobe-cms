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

const HOST = 'studio.localhost'

let payload: Payload

const ids = { site: '', package: '', target: '', settings: '', homePage: '' }
const otherSiteId = { value: '' }
let siteApiKey = ''

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

const adminReq = async () => {
  const admin = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: 'admin@eshobe.test' } },
  })
  return createLocalReq({ user: { ...admin.docs[0]!, collection: 'users' } }, payload)
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })

  const { docs: allSites } = await payload.find({ collection: 'sites', depth: 0, pagination: false })
  const studio = (allSites as { domain: string; id: string }[]).find((site) => site.domain === HOST)
  const acme = (allSites as { domain: string; id: string }[]).find(
    (site) => site.domain === 'acme.localhost',
  )
  if (!studio) throw new Error(`Site ${HOST} missing — run pnpm seed`)
  if (!acme) throw new Error('Site acme.localhost missing — run pnpm seed')
  ids.site = String(studio.id)
  otherSiteId.value = String(acme.id)

  await payload.delete({
    collection: 'site-theme-settings',
    overrideAccess: true,
    where: { site: { equals: ids.site } },
  })
  await payload.delete({
    collection: 'site-deployments',
    overrideAccess: true,
    where: { site: { equals: ids.site } },
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
  ids.target = String(target.id)

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
      domain: 'studio-descriptor.sites.descriptor.invalid',
      domainMode: 'preview',
      site: ids.site,
      status: 'failed',
      target: target.id,
      themePackage: pkg.id,
    },
    overrideAccess: true,
  })
  expect(idOf(deployment.site)).toBe(ids.site)

  const home = await payload.find({
    collection: 'pages',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { and: [{ site: { equals: ids.site } }, { slug: { equals: 'home' } }] },
  })
  const fallback = home.docs[0]
    ? home.docs[0]
    : (
        await payload.find({
          collection: 'pages',
          depth: 0,
          limit: 1,
          overrideAccess: true,
          where: { site: { equals: ids.site } },
        })
      ).docs[0]
  if (!fallback) throw new Error('Studio has no pages — run pnpm seed')
  ids.homePage = String(fallback.id)

  const req = await adminReq()
  const issued = await issueApiKeyEndpoint.handler!(
    await createLocalReq(
      {
        req: {
          json: async () => ({
            name: 'کلید استودیو (توصیف‌گر)',
            role: 'site',
            siteId: ids.site,
          }),
        } as Partial<PayloadRequest>,
        user: req.user ?? undefined,
      },
      payload,
    ),
  )
  siteApiKey = String(((await issued.json()) as { key?: string }).key ?? '')

  expect(await themePackageForSite(req, ids.site)).toBeTruthy()

  const saveRes = await themeSettingsSaveEndpoint.handler!(
    await createLocalReq(
      {
        req: {
          json: async () => ({
            bindings: { home: ids.homePage },
            runtimeSettings: { density: 'compact', showNumbers: false },
            site: ids.site,
            values: {},
          }),
        } as Partial<PayloadRequest>,
        user: req.user ?? undefined,
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
    where: { site: { equals: ids.site } },
  })
  ids.settings = String(settings.docs[0]?.id ?? '')
}, 180_000)

afterAll(async () => {
  await payload.delete({
    collection: 'site-theme-settings',
    overrideAccess: true,
    where: { site: { equals: ids.site } },
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
    const res = await fetchDescriptor(HOST)
    expect(res.status).toBe(200)
    const body = assertGenericSiteDescriptor(await res.json())

    expect(body.branding.displayName).toBeTruthy()
    expect(body.themeRuntime).toMatchObject({
      package: { key: 'descriptor-theme' },
      settings: { density: 'compact', showNumbers: false },
    })
    expect(body.themeRuntime?.bindings.home).toMatchObject({
      id: ids.homePage,
      type: 'page',
    })
    expect(JSON.stringify(body)).not.toMatch(/coolify|apiToken|secretValues|enc:v1/i)
  })

  it('changes ETag when runtime settings are updated', async () => {
    const before = await fetchDescriptor(HOST)
    const etagBefore = before.headers.get('etag')

    const req = await adminReq()
    await themeSettingsSaveEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            json: async () => ({
              runtimeSettings: { density: 'comfortable', showNumbers: true },
              site: ids.site,
            }),
          } as Partial<PayloadRequest>,
          user: req.user ?? undefined,
        },
        payload,
      ),
    )

    const after = await fetchDescriptor(HOST)
    expect(after.headers.get('etag')).not.toBe(etagBefore)
  })

  it('changes Last-Modified when a bound page changes', async () => {
    const before = await fetchDescriptor(HOST)
    const modifiedBefore = before.headers.get('last-modified')

    await payload.update({
      collection: 'pages',
      context: { disableRevalidate: true },
      data: { title: 'Home updated for descriptor test' },
      id: ids.homePage,
      locale: 'fa',
      overrideAccess: true,
    })

    const after = await fetchDescriptor(HOST)
    expect(Date.parse(after.headers.get('last-modified')!)).toBeGreaterThanOrEqual(
      Date.parse(modifiedBefore!),
    )
  })

  it('resolves deleted binding targets to null', async () => {
    const temp = await payload.create({
      collection: 'categories',
      context: { disableRevalidate: true },
      data: {
        site: ids.site,
        slug: 'temp-binding-target',
        title: 'Temp category',
      },
      locale: 'fa',
      overrideAccess: true,
    })

    const req = await adminReq()
    await themeSettingsSaveEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            json: async () => ({
              bindings: { home: ids.homePage, projects: String(temp.id) },
              site: ids.site,
            }),
          } as Partial<PayloadRequest>,
          user: req.user ?? undefined,
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

    const res = await fetchDescriptor(HOST)
    const body = (await res.json()) as { themeRuntime?: { bindings?: Record<string, unknown> } }
    expect(body.themeRuntime?.bindings?.projects).toBeNull()
  })

  it('refuses cross-site content bindings at save time', async () => {
    const foreignPage = await payload.find({
      collection: 'pages',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { site: { equals: otherSiteId.value } },
    })
    const req = await adminReq()
    const res = await themeSettingsSaveEndpoint.handler!(
      await createLocalReq(
        {
          req: {
            json: async () => ({
              bindings: { home: String(foreignPage.docs[0]?.id) },
              site: ids.site,
            }),
          } as Partial<PayloadRequest>,
          user: req.user ?? undefined,
        },
        payload,
      ),
    )
    expect(res.status).toBe(400)
  })

  it('adds id and domainVerified only for a site API key, not for Host resolution', async () => {
    const publicRes = await fetchDescriptor(HOST)
    const publicBody = (await publicRes.clone().json()) as Record<string, unknown>
    expect(publicBody.id).toBeUndefined()
    expect(publicBody.domainVerified).toBeUndefined()

    const keyed = await fetchDescriptor('localhost', { authorization: `Bearer ${siteApiKey}` })
    expect(keyed.status).toBe(200)
    const keyedBody = (await keyed.json()) as Record<string, unknown>
    expect(keyedBody.id).toBe(ids.site)
    expect(keyedBody).toHaveProperty('domainVerified')
  })
})

describe('GET /api/site — deployment secrets stay out of the descriptor', () => {
  it('never exposes deployment env or ciphertext', async () => {
    const raw = JSON.stringify(await (await fetchDescriptor(HOST)).json())
    expect(raw).not.toContain('coolify_descriptor_token')
    expect(raw).not.toContain('secretValues')
    expect(raw).not.toContain('enc:v1')
  })
})
