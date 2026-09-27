// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { bindingAppName } from '@/lib/deploy/appIdentity'
import {
  claimBindingProvisioning,
  ensureThemeBinding,
} from '@/deploy/bindings'

let payload: Payload
let siteId = ''
let packageId = ''
let targetId = ''
let adminReq: PayloadRequest

beforeAll(async () => {
  payload = await getPayload({ config })

  const { docs: sites } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: 'acme' } },
  })
  if (!sites[0]) throw new Error('seed missing')
  siteId = String(sites[0].id)

  const { docs: admins } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: 'admin@eshobe.test' } },
  })
  if (!admins[0]) throw new Error('admin missing')
  adminReq = await createLocalReq({ user: { ...admins[0], collection: 'users' } }, payload)

  await payload.delete({
    collection: 'theme-bindings',
    overrideAccess: true,
    where: { site: { equals: siteId } },
  })

  const target = await payload.create({
    collection: 'deploy-targets',
    data: {
      active: true,
      apiToken: 'token',
      baseUrl: 'https://coolify.test.invalid',
      environmentName: 'production',
      gitSource: 'public',
      key: 'binding-test-target',
      name: 'Binding test',
      previewProjectUuid: 'prev-proj',
      productionProjectUuid: 'prod-proj',
      projectUuid: 'prod-proj',
      provider: 'coolify',
      serverUuid: 'server-1',
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
      key: 'binding-test-theme',
      manifest: { build: { pack: 'nixpacks', port: 3000 }, contractVersion: 1, key: 'binding-test-theme', name: 'T', siteTypes: ['business'] },
      name: 'Binding test theme',
      provider: 'github',
      repository: 'hamidnoshady/example',
      status: 'published',
      visibility: 'public',
    },
    overrideAccess: true,
  })
  packageId = String(pkg.id)
})

afterAll(async () => {
  await payload.delete({
    collection: 'theme-bindings',
    overrideAccess: true,
    where: { site: { equals: siteId } },
  })
  await payload.delete({ collection: 'theme-packages', id: packageId, overrideAccess: true })
  await payload.delete({ collection: 'deploy-targets', id: targetId, overrideAccess: true })
})

describe('theme binding persistence', () => {
  it('uses the same binding and app name when the site domain changes', async () => {
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const targetDoc = (await payload.findByID({
      collection: 'deploy-targets',
      depth: 0,
      id: targetId,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const nameBefore = bindingAppName(siteId, 'binding-test-theme', 'production')

    const first = await ensureThemeBinding({
      applicationHostname: 'preview.test.invalid',
      domainMode: 'direct',
      lane: 'production',
      req: adminReq,
      site,
      siteId,
      targetDoc,
      themeKey: 'binding-test-theme',
      themePackageId: packageId,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const originalDomain = String(site.domain ?? '')

    await payload.update({
      collection: 'sites',
      data: { domain: 'changed-domain.example.com' },
      id: siteId,
      overrideAccess: true,
    })

    const siteAfter = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const second = await ensureThemeBinding({
      applicationHostname: 'preview.test.invalid',
      domainMode: 'direct',
      lane: 'production',
      req: adminReq,
      site: siteAfter,
      siteId,
      targetDoc,
      themeKey: 'binding-test-theme',
      themePackageId: packageId,
    })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(String(second.binding.id)).toBe(String(first.binding.id))
    expect(String(second.binding.appName)).toBe(nameBefore)
    expect(bindingAppName(siteId, 'binding-test-theme', 'production')).toBe(nameBefore)

    await payload.update({
      collection: 'sites',
      data: { domain: originalDomain },
      id: siteId,
      overrideAccess: true,
    })
  })

  it('allows only one provisioning claim at a time per binding', async () => {
    const site = (await payload.findByID({
      collection: 'sites',
      depth: 0,
      id: siteId,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>
    const targetDoc = (await payload.findByID({
      collection: 'deploy-targets',
      depth: 0,
      id: targetId,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>

    const ensured = await ensureThemeBinding({
      applicationHostname: 'p.preview.test',
      domainMode: 'preview',
      lane: 'preview',
      req: adminReq,
      site,
      siteId,
      targetDoc,
      themeKey: 'binding-test-theme',
      themePackageId: packageId,
    })
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) return

    const id = String(ensured.binding.id)
    const depA = await payload.create({
      collection: 'site-deployments',
      data: {
        domain: 'preview.test',
        domainMode: 'preview',
        lane: 'preview',
        site: siteId,
        status: 'queued',
        target: targetId,
        themePackage: packageId,
      },
      overrideAccess: true,
      req: adminReq,
    })
    const depB = await payload.create({
      collection: 'site-deployments',
      data: {
        domain: 'preview.test',
        domainMode: 'preview',
        lane: 'preview',
        site: siteId,
        status: 'queued',
        target: targetId,
        themePackage: packageId,
      },
      overrideAccess: true,
      req: adminReq,
    })

    const wonA = await claimBindingProvisioning(adminReq, id, String(depA.id))
    const wonB = await claimBindingProvisioning(adminReq, id, String(depB.id))

    expect(wonA).toBe(true)
    expect(wonB).toBe(false)

    await payload.update({
      collection: 'theme-bindings',
      data: { provisioningDeployment: undefined, state: 'active' },
      id,
      overrideAccess: true,
    })

    await payload.delete({ collection: 'site-deployments', id: String(depA.id), overrideAccess: true })
    await payload.delete({ collection: 'site-deployments', id: String(depB.id), overrideAccess: true })
  })
})
