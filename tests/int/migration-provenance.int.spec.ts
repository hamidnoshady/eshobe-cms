// @vitest-environment node
//
// Issue #236, the runtime half of `tests/int/migration-editor.int.spec.ts`.
//
// The config spec proves `source.access.create/update` are denied and the group
// is hidden. This one proves what Payload actually *does* with that, against a
// real Postgres schema — the part a config assertion cannot see:
//
//  1. An ordinary save (a platform admin posting through the normal collection
//     access, no `overrideAccess`) can neither rewrite an imported record's
//     provenance nor forge provenance on a create. Payload deletes the denied
//     group and falls back to the stored document / the native defaults.
//  2. A service write still succeeds: `overrideAccess: true` writes what it is
//     given, which is how the import engine records WordPress/WooCommerce
//     origin.
//  3. The café-menu integration keeps storing the origin it intends. Its
//     category/definition creates run with `overrideAccess: false` and name a
//     native `{ system: 'eshobe', mappingStatus: 'manual' }` origin; after the
//     lockdown that intent is carried by `PROVENANCE_WRITE_CONTEXT_KEY` rather
//     than by the group's defaults, so a changed default can never silently
//     relabel POS-created terms.
//
// Self-contained: it creates its own site, admin and API key, and removes them
// again, so it neither depends on `pnpm seed` data nor leaves any behind.
import type { Payload, PayloadRequest } from 'payload'

import { randomUUID } from 'node:crypto'

import { createLocalReq, getPayload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import type { User } from '@/payload-types'
import { PROVENANCE_WRITE_CONTEXT_KEY } from '@/collections/fields/migrationSource'
import { issueApiKeyEndpoint } from '@/endpoints/apiKeys'
import { upsertCafeCategory } from '@/endpoints/cafeMenuSync'
import { idOf } from '@/lib/ids'
import { resetRateLimits } from '@/lib/rate-limit'

import { cmsTypedUser } from './cmsUser'

let payload: Payload
const suffix = randomUUID().slice(0, 8)
const domain = `provenance-${suffix}.localhost`
const userIds: string[] = []
const apiKeyIds: string[] = []
const pageIds: string[] = []
const termIds: string[] = []
const taxonomyIds: string[] = []
let siteId = ''
let adminUser: null | User = null

const noRevalidate = { disableRevalidate: true }

/** The exact provenance an import writes; used as the "before" value. */
const importedSource = {
  contentHash: 'a'.repeat(64),
  installation: 'wordpress.example',
  mappingStatus: 'imported' as const,
  permalink: 'https://wordpress.example/?p=42',
  sourceId: '42',
  sourceType: 'post',
  system: 'wordpress' as const,
}

const findPage = (id: string) =>
  payload.findByID({ collection: 'pages', depth: 0, id, overrideAccess: true })

/** Drafts-enabled collections type `create` as a discriminated union; these specs are not about that. */
const asData = (value: unknown): never => value as never

/** A fresh staff request per operation: Payload's Local API mutates `req.context`. */
const adminRequest = async (): Promise<PayloadRequest> => {
  const req = await createLocalReq({ user: cmsTypedUser(adminUser!) }, payload)
  req.context.disableRevalidate = true
  return req
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })

  const admin = await payload.create({
    collection: 'users',
    data: {
      email: `provenance-${suffix}@test.local`,
      name: 'Provenance Admin',
      password: `provenance-test-${suffix}`,
      role: 'platformAdmin',
    },
    overrideAccess: true,
  })
  userIds.push(String(admin.id))

  adminUser = admin

  const site = await payload.create({
    collection: 'sites',
    data: asData({ domain, name: `Provenance ${suffix}`, slug: `provenance-${suffix}`, type: 'business' }),
    overrideAccess: true,
    context: noRevalidate,
  })
  siteId = String(site.id)

  resetRateLimits()
}, 180_000)

afterAll(async () => {
  if (!payload) return
  for (const id of pageIds) {
    await payload.delete({ collection: 'pages', id, overrideAccess: true }).catch(() => null)
  }
  for (const id of termIds) {
    await payload.delete({ collection: 'taxonomy-terms', id, overrideAccess: true }).catch(() => null)
  }
  for (const id of taxonomyIds) {
    await payload
      .delete({ collection: 'taxonomy-definitions', id, overrideAccess: true })
      .catch(() => null)
  }
  for (const id of apiKeyIds) {
    await payload.delete({ collection: 'api-keys', id, overrideAccess: true }).catch(() => null)
  }
  // Users first: a user row references the site through `tenants`, and deleting
  // a site somebody still references fails.
  for (const id of userIds) {
    await payload.delete({ collection: 'users', id, overrideAccess: true }).catch(() => null)
  }
  if (siteId) {
    await payload
      .delete({ collection: 'sites', id: siteId, overrideAccess: true, context: noRevalidate })
      .catch(() => null)
  }
}, 180_000)

describe.sequential('provenance lockdown (#236)', () => {
  it('keeps an imported record’s provenance through ordinary edits and publish', async () => {
    const page = await payload.create({
      collection: 'pages',
      context: noRevalidate,
      data: asData({
        layout: [{ blockType: 'content', columns: [] }],
        site: siteId,
        slug: `imported-${suffix}`,
        source: importedSource,
        title: 'Imported page',
      }),
      overrideAccess: true,
    })
    pageIds.push(String(page.id))
    expect(page.source?.system).toBe('wordpress')

    // An ordinary save — no `overrideAccess` — that tries to relabel the
    // document. The title must change; the provenance must not.
    const edited = await payload.update({
      collection: 'pages',
      context: noRevalidate,
      data: {
        source: {
          contentHash: 'b'.repeat(64),
          installation: 'attacker.example',
          mappingStatus: 'archived',
          permalink: 'https://attacker.example/x',
          sourceId: '999',
          system: 'woocommerce',
        },
        title: 'Edited title',
      },
      id: page.id,
      overrideAccess: false,
      req: await adminRequest(),
    })
    expect(edited.title).toBe('Edited title')

    const reread = await findPage(String(page.id))
    expect(reread.source).toMatchObject(importedSource)

    // Publishing is still an ordinary save: it must not touch provenance either.
    await payload.update({
      collection: 'pages',
      context: noRevalidate,
      data: { _status: 'published' },
      id: page.id,
      overrideAccess: false,
      req: await adminRequest(),
    })
    const published = await findPage(String(page.id))
    expect(published._status).toBe('published')
    expect(published.source).toMatchObject(importedSource)
  }, 120_000)

  it('drops forged provenance on an ordinary create and keeps the native defaults', async () => {
    const created = await payload.create({
      collection: 'pages',
      context: noRevalidate,
      data: asData({
        layout: [{ blockType: 'content', columns: [] }],
        site: siteId,
        slug: `native-${suffix}`,
        // A native editor cannot claim a WordPress origin.
        source: {
          installation: 'attacker.example',
          mappingStatus: 'imported',
          sourceId: '7',
          system: 'wordpress',
        },
        title: 'Native page',
      }),
      overrideAccess: false,
      req: await adminRequest(),
    })
    pageIds.push(String(created.id))

    expect(created.source?.system).toBe('eshobe')
    expect(created.source?.mappingStatus).toBe('manual')
    expect(created.source?.sourceId ?? null).toBeNull()
    expect(created.source?.installation ?? null).toBeNull()
  }, 120_000)

  it('lets a service write record a new origin', async () => {
    const page = await payload.create({
      collection: 'pages',
      context: noRevalidate,
      data: asData({
        layout: [{ blockType: 'content', columns: [] }],
        site: siteId,
        slug: `service-${suffix}`,
        title: 'Service page',
      }),
      overrideAccess: true,
    })
    pageIds.push(String(page.id))
    expect(page.source?.system).toBe('eshobe')

    const updated = await payload.update({
      collection: 'pages',
      context: noRevalidate,
      data: {
        source: {
          contentHash: 'c'.repeat(64),
          installation: 'woo.example',
          mappingStatus: 'imported',
          sourceId: '55',
          system: 'woocommerce',
        },
      },
      id: page.id,
      overrideAccess: true,
    })
    expect(updated.source?.system).toBe('woocommerce')
    expect(updated.source?.sourceId).toBe('55')
    expect(updated.source?.contentHash).toBe('c'.repeat(64))
  }, 120_000)

  it('keeps the café-menu integration’s intended origin on a non-override create', async () => {
    const issued = await issueApiKeyEndpoint.handler(
      await createLocalReq(
        {
          req: {
            json: async () => ({ name: 'provenance café', role: 'site', siteId }),
          } as Partial<PayloadRequest>,
          user: cmsTypedUser(adminUser!),
        },
        payload,
      ),
    )
    expect(issued.status).toBe(201)
    const key = (await issued.json()) as { id: string; key: string }
    apiKeyIds.push(key.id)

    const sourceId = `provenance-category-${suffix}`
    const body = JSON.stringify({ name: 'قهوه' })
    const req = await createLocalReq(
      {
        req: {
          body: { name: 'قهوه' },
          headers: new Headers({
            authorization: `Bearer ${key.key}`,
            'content-length': String(body.length),
            'content-type': 'application/json',
            host: domain,
          }),
          method: 'PUT',
          payloadAPI: 'REST',
          routeParams: { sourceId },
          text: async () => body,
          url: `http://${domain}/api/site/cafe-menu/categories/${sourceId}`,
        } as unknown as Partial<PayloadRequest>,
      },
      payload,
    )
    req.context.disableRevalidate = true

    const response = await upsertCafeCategory(req)
    expect(response.status).toBe(200)
    const result = (await response.json()) as { id: string; ok: boolean }
    expect(result.ok).toBe(true)
    termIds.push(result.id)

    const term = await payload.findByID({
      collection: 'taxonomy-terms',
      depth: 0,
      id: result.id,
      overrideAccess: true,
    })
    // The endpoint passed `{ system: 'eshobe', mappingStatus: 'manual' }` with
    // `overrideAccess: false`; the context flag is what keeps it, not a default.
    expect(term.source?.system).toBe('eshobe')
    expect(term.source?.mappingStatus).toBe('manual')
    expect(term.source?.sourceId ?? null).toBeNull()
    taxonomyIds.push(String(idOf(term.taxonomy)))

    // And the same integration can never be repointed at another origin.
    const forged = await payload.update({
      collection: 'taxonomy-terms',
      data: { source: { installation: 'attacker', mappingStatus: 'imported', sourceId: '1', system: 'wordpress' } },
      id: result.id,
      overrideAccess: false,
      req: await adminRequest(),
    })
    expect(forged.source?.system).toBe('eshobe')

    // A service write with the explicit flag (what `ensureTaxonomy` does) is
    // still allowed to name provenance.
    const flagged = await payload.create({
      collection: 'taxonomy-definitions',
      context: { ...noRevalidate, [PROVENANCE_WRITE_CONTEXT_KEY]: true },
      data: {
        hierarchical: true,
        key: `provenance-flagged-${suffix}`,
        pluralLabel: 'آزمایشی',
        singularLabel: 'آزمایشی',
        site: siteId,
        source: { system: 'eshobe', mappingStatus: 'manual' },
      },
      overrideAccess: false,
      req: await adminRequest(),
    })
    taxonomyIds.push(String(flagged.id))
    expect(flagged.source?.system).toBe('eshobe')
    expect(flagged.source?.mappingStatus).toBe('manual')
  }, 180_000)
})
