import type { Page, Site } from '@/payload-types'
import type { Payload, TypedUser } from 'payload'

import { getPayload, ValidationError } from 'payload'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'
import { blockSlugsForSiteType } from '@/blocks'

/**
 * `src/blocks/index.ts` narrows the block picker per site type through the
 * `filterOptions` on the Pages `layout` field. The picker is only UI — the
 * security-relevant claim is the comment on `allowedBlocks`: that Payload
 * *re-checks* `filterOptions` when the document is saved, so a block the type
 * is not allowed to hold is rejected even when it arrives over the REST/Local
 * API with the admin picker bypassed.
 *
 * This suite pins that server-side enforcement: hidden-in-the-UI is not the
 * boundary, the save-time validation is. It runs against real access control
 * (`overrideAccess: false` + a real tenant user), because a check that only
 * holds with access overridden would not protect the API. Run `pnpm seed` first.
 */
let payload: Payload

const site = async (domain: string): Promise<Site> => {
  const { docs } = await payload.find({
    collection: 'sites',
    limit: 1,
    overrideAccess: true,
    where: { domain: { equals: domain } },
  })

  if (!docs[0]) throw new Error(`Site ${domain} missing — run \`pnpm seed\``)

  return docs[0]
}

const owner = async (email: string): Promise<TypedUser> => {
  const { docs } = await payload.find({
    collection: 'users',
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })

  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)

  return { ...docs[0], collection: 'users' } as TypedUser
}

/**
 * Saves a one-block page on `site` as `user`, returns the block that was
 * rejected (`null` when the save was accepted). Any page that slips through is
 * deleted so the assertion cannot leave tenant data behind.
 */
const rejectedBlockFor = async (
  user: TypedUser,
  siteId: number | string,
  blockType: string,
  slug: string,
): Promise<null | string> => {
  let created: null | Page = null

  try {
    created = await payload.create({
      collection: 'pages',
      data: {
        layout: [{ blockType, id: `${blockType}-1` }],
        site: siteId,
        slug,
        title: `gating ${blockType}`,
      } as never,
      overrideAccess: false,
      user,
    })

    return null
  } catch (error) {
    if (error instanceof ValidationError) return blockType

    throw error
  } finally {
    if (created) await payload.delete({ collection: 'pages', id: created.id, overrideAccess: true })
  }
}

describe('block library — site-type gating is enforced on save, not just in the picker', () => {
  let business: Site
  let store: Site
  let businessOwner: TypedUser
  let storeOwner: TypedUser
  const madePages: string[] = []

  beforeAll(async () => {
    payload = await getPayload({ config: await config })
    business = await site('acme.localhost')
    store = await site('shop.localhost')
    businessOwner = await owner('acme@eshobe.test')
    storeOwner = await owner('shop@eshobe.test')

    // The fixtures have to be the types this suite reasons about, or every
    // assertion below is vacuous.
    expect(business.type).toBe('business')
    expect(store.type).toBe('store')
  })

  afterEach(async () => {
    while (madePages.length) {
      const id = madePages.pop()!
      await payload.delete({ collection: 'pages', id, overrideAccess: true }).catch(() => {})
    }
  })

  it('rejects the store-only productGrid block on a business site over the API', async () => {
    // The picker would never offer it, but the picker is not the boundary.
    expect(blockSlugsForSiteType('business')).not.toContain('productGrid')

    expect(await rejectedBlockFor(businessOwner, business.id, 'productGrid', 'gate-pg-business')).toBe(
      'productGrid',
    )
  })

  it('accepts a shared block on that same business site', async () => {
    // Same code path, allowed block: proves the rejection above is the type
    // filter doing its job, not pages refusing every layout the API sends.
    expect(blockSlugsForSiteType('business')).toContain('content')

    const created = await payload.create({
      collection: 'pages',
      data: {
        layout: [{ blockType: 'content', columns: [], id: 'content-1' }],
        site: business.id,
        slug: 'gate-content-business',
        title: 'gating content',
      } as never,
      overrideAccess: false,
      user: businessOwner,
    })
    madePages.push(String(created.id))

    expect(created.id).toBeTruthy()
  })

  it('rejects a business/portfolio-only block on a store site over the API', async () => {
    // The gate runs in both directions: a store may not hold the gallery block.
    expect(blockSlugsForSiteType('store')).not.toContain('gallery')

    expect(await rejectedBlockFor(storeOwner, store.id, 'gallery', 'gate-gallery-store')).toBe('gallery')
  })

  it('accepts the productGrid block on a store site', async () => {
    expect(blockSlugsForSiteType('store')).toContain('productGrid')

    const created = await payload.create({
      collection: 'pages',
      data: {
        layout: [{ blockType: 'productGrid', id: 'pg-store-1' }],
        site: store.id,
        slug: 'gate-pg-store',
        title: 'gating productGrid',
      } as never,
      overrideAccess: false,
      user: storeOwner,
    })
    madePages.push(String(created.id))

    expect(created.id).toBeTruthy()
  })
})
