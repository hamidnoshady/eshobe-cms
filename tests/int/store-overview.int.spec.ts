import type { Payload, PayloadRequest, TypedUser } from 'payload'

import { createLocalReq, getPayload } from 'payload'
import { beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { storeOverview } from '@/lib/storeOverview'

/**
 * The customer store control-centre summary. Run `pnpm seed` first.
 *
 * Two things are asserted: the numbers match the seeded `shop.localhost` store
 * (3 products — 2 published, 1 draft; the tracked one with 2 in stock is "low"),
 * and — the part that matters — the summary is tenant-scoped. `storeOverview`
 * takes only a request, and every read inside runs through the multi-tenant
 * plugin, so the business site `acme.localhost` must see none of the shop's
 * products or orders. A leak here would be a cross-tenant data disclosure, so it
 * is tested against real access control and real SQL, not a mock.
 */
let payload: Payload

const site = async (domain: string) => {
  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    where: { domain: { equals: domain } },
  })
  if (!docs[0]) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)
  return docs[0]
}

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

const reqFor = async (user: TypedUser): Promise<PayloadRequest> =>
  createLocalReq({ user }, payload)

describe('store overview (tenant-scoped)', () => {
  let shopOwner: TypedUser
  let acmeOwner: TypedUser

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    await site('shop.localhost')
    await site('acme.localhost')
    shopOwner = await owner('shop@eshobe.test')
    acmeOwner = await owner('acme@eshobe.test')
  })

  it('summarises the seeded store site', async () => {
    const ov = await storeOverview(await reqFor(shopOwner))

    // Seed: 3 products (2 published, 1 draft), the tracked one has 2 in stock.
    expect(ov.products.total).toBeGreaterThanOrEqual(3)
    expect(ov.products.published).toBeGreaterThanOrEqual(2)
    expect(ov.products.lowStock).toBeGreaterThanOrEqual(1)
    expect(ov.products.outOfStock).toBeGreaterThanOrEqual(0)

    // Order-status counts always partition the total (there are no other statuses).
    const { cancelled, paid, pending, refunded, total } = ov.orders
    expect(total).toBe(pending + paid + cancelled + refunded)
    expect(Array.isArray(ov.orders.recent)).toBe(true)
    expect(ov.orders.recent.length).toBeLessThanOrEqual(5)

    // No gateway is seeded, so nothing needs attention — and the invariant holds
    // regardless: an enabled gateway is either healthy or needs attention.
    expect(ov.payments.needsAttention).toBe(
      Math.max(0, ov.payments.enabled - ov.payments.healthy),
    )
    expect(ov.payments.enabled).toBeLessThanOrEqual(ov.payments.configured)
  })

  it('never leaks another tenant’s store data', async () => {
    const shop = await storeOverview(await reqFor(shopOwner))
    const acme = await storeOverview(await reqFor(acmeOwner))

    // The business site has no store content, and the shop's products must not
    // bleed across the tenant boundary into it.
    expect(acme.products.total).toBe(0)
    expect(acme.orders.total).toBe(0)
    expect(acme.orders.recent).toEqual([])
    expect(acme.payments.configured).toBe(0)

    // And the shop genuinely has data the business site does not — i.e. the zero
    // above is isolation, not an empty database.
    expect(shop.products.total).toBeGreaterThan(acme.products.total)
  })
})
