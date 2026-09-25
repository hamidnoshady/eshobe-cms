// @vitest-environment node
//
// Real sessions via `createLocalReq({ user })` — see `deployments.int.spec.ts` for why
// this family of specs runs in the node environment.
import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { themeSettingsGetEndpoint, themeSettingsSaveEndpoint } from '@/endpoints/themeSettings'
import { buildEnvironment, storedTenantValues } from '@/deploy/environment'
import { parseThemeManifest, type ThemeManifest } from '@/lib/deploy/manifest'

/**
 * WAVE-11 — the customer's side of a deployable theme: `GET|POST
 * /api/site-theme-settings/current`, and the collection behind it.
 *
 * The property: a site's own owner answers the variables the theme the site runs
 * asked *them* for — and nothing else. Not another site's settings, not the package,
 * not a platform variable, and never a secret back out, encrypted or not.
 *
 * Run `pnpm seed` first.
 */
let payload: Payload

const siteId = { acme: '', shop: '' }
let packageId = ''
let targetId = ''
let settingsId = ''
let acmeSiteKey = ''

const SECRET = 'map-secret-value-1'

const manifest = (): ThemeManifest => {
  const parsed = parseThemeManifest(
    {
      build: { pack: 'nixpacks', port: 3000 },
      contractVersion: 1,
      env: [
        { key: 'MAP_API_KEY', labelFa: 'کلید نقشه', required: true, secret: true, source: 'tenant' },
        { help: 'شناسهٔ گوگل آنالیتیکس', key: 'ANALYTICS_ID', labelFa: 'شناسهٔ آمار', source: 'tenant' },
        { key: 'ESHOBE_CMS_URL', source: 'platform' },
      ],
      key: 'settings-theme',
      name: 'Settings Theme',
      siteTypes: ['business', 'portfolio', 'store'],
    },
    1,
  )
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}

const userByEmail = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({ collection: 'users', depth: 0, limit: 1, where: { email: { equals: email } } })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return docs[0]
}

/** A customer session. Asserts the fixture is *not* a platform admin, or every refusal below passes vacuously. */
const reqAs = async (email: string, extra: Partial<PayloadRequest> = {}): Promise<PayloadRequest> => {
  const user = await userByEmail(email)
  if (email !== 'admin@eshobe.test') expect(user.role).not.toBe('platformAdmin')
  return createLocalReq({ req: extra, user: { ...user, collection: 'users' } }, payload)
}

const get = (site: string): Partial<PayloadRequest> =>
  ({ url: `http://localhost/api/site-theme-settings/current?site=${site}` }) as Partial<PayloadRequest>

const post = (body: unknown): Partial<PayloadRequest> =>
  ({ json: async () => body, url: 'http://localhost/api/site-theme-settings/current' }) as Partial<PayloadRequest>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyOf = async (res: Response): Promise<{ raw: string; json: Record<string, any> }> => {
  const raw = await res.text()
  return { json: JSON.parse(raw), raw }
}

beforeAll(async () => {
  payload = await getPayload({ config })

  for (const slug of ['acme', 'shop'] as const) {
    const { docs } = await payload.find({ collection: 'sites', depth: 0, limit: 1, where: { slug: { equals: slug } } })
    if (!docs[0]) throw new Error(`Site ${slug} missing — run \`pnpm seed\``)
    siteId[slug] = String(docs[0].id)
  }

  await payload.delete({ collection: 'site-theme-settings', overrideAccess: true, where: { site: { in: Object.values(siteId) } } })
  await payload.delete({ collection: 'site-deployments', overrideAccess: true, where: { site: { in: Object.values(siteId) } } })
  await payload.delete({ collection: 'theme-packages', overrideAccess: true, where: { key: { equals: 'settings-theme' } } })
  await payload.delete({ collection: 'deploy-targets', overrideAccess: true, where: { key: { equals: 'settings-target' } } })

  const target = await payload.create({
    collection: 'deploy-targets',
    data: {
      active: true,
      apiToken: 'coolify_settings_token',
      baseUrl: 'https://coolify.settings.invalid',
      environmentName: 'production',
      gitSource: 'public',
      key: 'settings-target',
      name: 'سرور تنظیمات',
      projectUuid: 'p',
      provider: 'coolify',
      serverUuid: 's',
      wildcardDomain: '*.sites.settings.invalid',
    },
    overrideAccess: true,
  })
  targetId = String(target.id)

  const pkg = await payload.create({
    collection: 'theme-packages',
    data: {
      contractVersion: 1,
      defaultRef: 'main',
      envSchema: manifest().env,
      key: 'settings-theme',
      manifest: manifest() as unknown as Record<string, unknown>,
      name: 'پوستهٔ تنظیمات',
      provider: 'github',
      repository: 'hamidnoshady/settings-theme',
      status: 'published',
      visibility: 'public',
    },
    overrideAccess: true,
  })
  packageId = String(pkg.id)

  // The site's theme comes from its deployments. A first deploy that failed for want
  // of a required value is exactly when the customer needs this form.
  await payload.create({
    collection: 'site-deployments',
    data: {
      domain: 'acme-settings.sites.settings.invalid',
      domainMode: 'preview',
      lastError: 'تنظیمات پوسته کامل نیست',
      site: siteId.acme,
      status: 'failed',
      target: targetId,
      themePackage: packageId,
    },
    overrideAccess: true,
  })

  const issued = await issueApiKeyEndpoint.handler!(
    await reqAs('admin@eshobe.test', { json: async () => ({ name: 'کلید آکمه (تنظیمات پوسته)', role: 'site', siteId: siteId.acme }) } as Partial<PayloadRequest>),
  )
  acmeSiteKey = String(((await issued.json()) as { key?: string }).key ?? '')
})

afterAll(async () => {
  await payload.delete({ collection: 'site-theme-settings', overrideAccess: true, where: { site: { in: Object.values(siteId) } } })
  await payload.delete({ collection: 'site-deployments', overrideAccess: true, where: { themePackage: { equals: packageId } } })
  await payload.delete({ collection: 'theme-packages', overrideAccess: true, where: { key: { equals: 'settings-theme' } } })
  await payload.delete({ collection: 'deploy-targets', overrideAccess: true, where: { key: { equals: 'settings-target' } } })
})

describe('the settings form a site owner sees', () => {
  it('is generated from the manifest of the theme the site runs — tenant variables only', async () => {
    const res = await themeSettingsGetEndpoint.handler!(await reqAs('acme@eshobe.test', get(siteId.acme)))
    expect(res.status).toBe(200)
    const { json } = await bodyOf(res)

    expect(json.package).toMatchObject({ id: packageId, key: 'settings-theme' })
    expect(json.canEdit).toBe(true)
    expect(json.fields.map((field: { key: string }) => field.key)).toEqual(['MAP_API_KEY', 'ANALYTICS_ID'])
    expect(json.fields[0]).toMatchObject({ label: 'کلید نقشه', required: true, secret: true, set: false })
    expect(json.fields[0].value).toBeUndefined()
    expect(json.fields[1]).toMatchObject({ help: 'شناسهٔ گوگل آنالیتیکس', secret: false, value: '' })
  })

  it('shows a helpful empty state for a site without a deployable theme', async () => {
    const res = await themeSettingsGetEndpoint.handler!(await reqAs('shop@eshobe.test', get(siteId.shop)))
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).json).toMatchObject({ fields: [], package: null })
  })
})

describe('saving', () => {
  it('stores the owner’s answers, the secret encrypted, and never echoes it', async () => {
    const res = await themeSettingsSaveEndpoint.handler!(
      await reqAs('acme@eshobe.test', post({ site: siteId.acme, values: { ANALYTICS_ID: 'G-111', MAP_API_KEY: SECRET } })),
    )
    expect(res.status).toBe(200)
    const { json, raw } = await bodyOf(res)
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain('enc:')
    expect(json.fields[0]).toMatchObject({ key: 'MAP_API_KEY', set: true })
    expect(json.fields[1]).toMatchObject({ key: 'ANALYTICS_ID', value: 'G-111' })

    const stored = await storedTenantValues(await reqAs('admin@eshobe.test'), siteId.acme, packageId)
    expect(stored.secrets.MAP_API_KEY).toBe(SECRET)
    expect(stored.plain).toEqual({ ANALYTICS_ID: 'G-111' })
    settingsId = String(stored.id)
  })

  it('never returns the secret or its ciphertext from a collection read — the owner’s own included', async () => {
    const asOwner = await payload.find({
      collection: 'site-theme-settings',
      overrideAccess: false,
      user: await userByEmail('acme@eshobe.test'),
    })
    const asAdmin = await payload.findByID({ collection: 'site-theme-settings', id: settingsId, overrideAccess: true })
    for (const payloadText of [JSON.stringify(asOwner), JSON.stringify(asAdmin)]) {
      expect(payloadText).not.toContain(SECRET)
      expect(payloadText).not.toContain('enc:')
    }
    expect(asOwner.docs.map((doc) => String(doc.id))).toContain(settingsId)
  })

  it('treats a blank secret as unchanged', async () => {
    const res = await themeSettingsSaveEndpoint.handler!(
      await reqAs('acme@eshobe.test', post({ site: siteId.acme, values: { ANALYTICS_ID: 'G-222', MAP_API_KEY: '' } })),
    )
    expect(res.status).toBe(200)
    const stored = await storedTenantValues(await reqAs('admin@eshobe.test'), siteId.acme, packageId)
    expect(stored.secrets.MAP_API_KEY).toBe(SECRET)
    expect(stored.plain.ANALYTICS_ID).toBe('G-222')
  })

  it('keeps the secret through an unrelated operator save of the raw document', async () => {
    // The update operation fills the omitted column from its own copy of the document,
    // which is masked. Encrypting that would replace the secret with eight dots.
    await payload.update({
      collection: 'site-theme-settings',
      data: { values: { ANALYTICS_ID: 'G-222' } },
      id: settingsId,
      overrideAccess: true,
    })
    const stored = await storedTenantValues(await reqAs('admin@eshobe.test'), siteId.acme, packageId)
    expect(stored.secrets.MAP_API_KEY).toBe(SECRET)
  })

  it('clears a secret only through the explicit clear list', async () => {
    const res = await themeSettingsSaveEndpoint.handler!(
      await reqAs('acme@eshobe.test', post({ clear: ['MAP_API_KEY'], site: siteId.acme, values: {} })),
    )
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).json.fields[0]).toMatchObject({ key: 'MAP_API_KEY', set: false })
    const stored = await storedTenantValues(await reqAs('admin@eshobe.test'), siteId.acme, packageId)
    expect(stored.secrets.MAP_API_KEY).toBeUndefined()

    // Put it back for the environment test below.
    await themeSettingsSaveEndpoint.handler!(
      await reqAs('acme@eshobe.test', post({ site: siteId.acme, values: { MAP_API_KEY: SECRET } })),
    )
  })

  it('refuses a platform variable and an undeclared key, and writes nothing', async () => {
    for (const values of [{ ESHOBE_CMS_URL: 'https://evil.example' }, { ESHOBE_API_KEY: 'x' }, { NOT_DECLARED: 'x' }]) {
      const res = await themeSettingsSaveEndpoint.handler!(await reqAs('acme@eshobe.test', post({ site: siteId.acme, values })))
      expect(res.status, JSON.stringify(values)).toBe(400)
    }
    const stored = await storedTenantValues(await reqAs('admin@eshobe.test'), siteId.acme, packageId)
    expect(Object.keys({ ...stored.plain, ...stored.secrets }).sort()).toEqual(['ANALYTICS_ID', 'MAP_API_KEY'])
  })

  it('ignores any attempt to choose the package or the site in the body', async () => {
    const res = await themeSettingsSaveEndpoint.handler!(
      await reqAs(
        'acme@eshobe.test',
        post({ site: siteId.acme, themePackage: 'another-package', values: { ANALYTICS_ID: 'G-333' } }),
      ),
    )
    expect(res.status).toBe(200)
    const doc = await payload.findByID({ collection: 'site-theme-settings', depth: 0, id: settingsId, overrideAccess: true })
    expect(String(doc.themePackage)).toBe(packageId)
    expect(String(doc.site)).toBe(siteId.acme)
  })
})

describe('who may', () => {
  it('refuses another site’s owner, both ways', async () => {
    const read = await themeSettingsGetEndpoint.handler!(await reqAs('shop@eshobe.test', get(siteId.acme)))
    expect(read.status).toBe(403)
    const write = await themeSettingsSaveEndpoint.handler!(
      await reqAs('shop@eshobe.test', post({ site: siteId.acme, values: { ANALYTICS_ID: 'stolen' } })),
    )
    expect(write.status).toBe(403)

    // And the collection itself shows them nothing of acme's.
    const { docs } = await payload.find({
      collection: 'site-theme-settings',
      overrideAccess: false,
      user: await userByEmail('shop@eshobe.test'),
    })
    expect(docs.map((doc) => String(doc.id))).not.toContain(settingsId)
  })

  it('lets an editor read but not write', async () => {
    const read = await themeSettingsGetEndpoint.handler!(await reqAs('acme-editor@eshobe.test', get(siteId.acme)))
    expect(read.status).toBe(200)
    expect((await bodyOf(read)).json.canEdit).toBe(false)
    const write = await themeSettingsSaveEndpoint.handler!(
      await reqAs('acme-editor@eshobe.test', post({ site: siteId.acme, values: { ANALYTICS_ID: 'x' } })),
    )
    expect(write.status).toBe(403)
  })

  it('refuses a site key and an anonymous caller — these are a person’s settings, not an integration’s', async () => {
    const withKey = (extra: Partial<PayloadRequest>) =>
      createLocalReq(
        { req: { headers: new Headers({ authorization: `Bearer ${acmeSiteKey}` }), ...extra } as Partial<PayloadRequest> },
        payload,
      )
    expect((await themeSettingsGetEndpoint.handler!(await withKey(get(siteId.acme)))).status).toBe(403)
    expect(
      (await themeSettingsSaveEndpoint.handler!(await withKey(post({ site: siteId.acme, values: {} })))).status,
    ).toBe(403)
    expect((await themeSettingsGetEndpoint.handler!(await createLocalReq({ req: get(siteId.acme) }, payload))).status).toBe(403)
  })

  it('refuses a customer’s write through the raw collection', async () => {
    const owner = await userByEmail('acme@eshobe.test')
    await expect(
      payload.update({
        collection: 'site-theme-settings',
        data: { values: { ANALYTICS_ID: 'direct' } },
        id: settingsId,
        overrideAccess: false,
        user: owner,
      }),
    ).rejects.toThrow()
    await expect(
      payload.create({
        collection: 'site-theme-settings',
        data: { site: siteId.acme, themePackage: packageId, values: {} },
        overrideAccess: false,
        user: owner,
      }),
    ).rejects.toThrow()
  })

  it('lets platform staff support a customer through the same route', async () => {
    const res = await themeSettingsGetEndpoint.handler!(await reqAs('admin@eshobe.test', get(siteId.acme)))
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).json.canEdit).toBe(true)
  })
})

describe('what reaches the build', () => {
  it('includes the tenant’s answers, and the platform values win', async () => {
    const req = await reqAs('admin@eshobe.test')
    const site = (await payload.findByID({ collection: 'sites', depth: 0, id: siteId.acme, overrideAccess: true })) as unknown as Record<
      string,
      unknown
    >
    const { errors, variables } = await buildEnvironment({
      apiKey: null,
      manifest: manifest(),
      req,
      revalidateSecret: 'esrv_test',
      serviceDomain: 'acme-settings.sites.settings.invalid',
      site,
      themePackageId: packageId,
    })

    expect(errors).toEqual([])
    expect(variables.find((v) => v.key === 'MAP_API_KEY')).toMatchObject({ isBuildTime: false, value: SECRET })
    expect(variables.find((v) => v.key === 'ANALYTICS_ID')?.value).toBe('G-333')
    expect(variables.filter((v) => v.key === 'ESHOBE_CMS_URL')).toHaveLength(1)
    expect(variables.find((v) => v.key === 'ESHOBE_CMS_URL')?.value).not.toContain('evil')
  })
})
