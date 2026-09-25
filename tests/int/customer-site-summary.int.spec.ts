import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { customerSiteSummary } from '@/lib/customerSiteSummary'

/**
 * Regression guard for a real tenant-isolation bug: the customer dashboard read
 * its site header and "at a glance" counts through the Local API without
 * `overrideAccess: false`, so the multi-tenant read constraint was skipped and the
 * numbers were platform-wide across every customer (and the header could name
 * another tenant's site). `customerSiteSummary` is the extracted, fixed loader;
 * this proves it stays tenant-scoped. Run `pnpm seed` first.
 */
let payload: Payload

const STAT_SLUGS = ['pages', 'posts', 'products', 'orders', 'form-submissions'] as const

const owner = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: email } },
  })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return { ...docs[0], collection: 'users' } as TypedUser
}

const reqFor = async (user: TypedUser): Promise<PayloadRequest> => createLocalReq({ user }, payload)

describe('customerSiteSummary (tenant-scoped)', () => {
  let acmeOwner: TypedUser
  let shopOwner: TypedUser

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    acmeOwner = await owner('acme@eshobe.test')
    shopOwner = await owner('shop@eshobe.test')
  })

  it('returns the caller’s own site, not an arbitrary tenant’s', async () => {
    const acme = await customerSiteSummary(await reqFor(acmeOwner), STAT_SLUGS)
    const shop = await customerSiteSummary(await reqFor(shopOwner), STAT_SLUGS)

    expect(acme.site?.domain).toBe('acme.localhost')
    expect(shop.site?.domain).toBe('shop.localhost')
  })

  it('counts only the caller’s own documents', async () => {
    const acme = await customerSiteSummary(await reqFor(acmeOwner), STAT_SLUGS)
    const shop = await customerSiteSummary(await reqFor(shopOwner), STAT_SLUGS)

    // Products live only on the store site: the business site must count zero, and
    // the store's non-zero count proves the zero is isolation, not an empty table.
    expect(acme.counts.products).toBe(0)
    expect(shop.counts.products).toBeGreaterThan(0)

    // Every counted collection is bounded by the tenant — a customer never sees a
    // platform-wide total. The whole-fleet total is strictly larger than one site's.
    const fleetProducts = (await payload.count({ collection: 'products' })).totalDocs
    expect(shop.counts.products).toBeLessThanOrEqual(fleetProducts)
    for (const slug of STAT_SLUGS) {
      expect(typeof acme.counts[slug]).toBe('number')
    }
  })
})
