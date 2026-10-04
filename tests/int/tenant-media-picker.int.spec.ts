// @vitest-environment node
import type { Payload } from 'payload'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

import type { Site } from '@/payload-types'
import config from '@/payload.config'
import { cmsTypedUser } from './cmsUser'
import { idOf } from '@/lib/ids'

const uuid = () => randomUUID()
const siteIDOf = (site: Site) => String(site.id)

let payload: Payload
let acme: Site
let studio: Site
let acmeOwner: Awaited<ReturnType<typeof cmsTypedUser>>
let studioOwner: Awaited<ReturnType<typeof cmsTypedUser>>
const mediaIDs: string[] = []
const folderIDs: string[] = []
const productIDs: string[] = []

const owner = async (email: string) => {
  const { docs } = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    where: { email: { equals: email } },
  })
  if (!docs[0]) throw new Error(`User ${email} missing — run \`pnpm seed\``)
  return cmsTypedUser(docs[0])
}

const site = async (slug: 'acme' | 'studio') => {
  const { docs } = await payload.find({
    collection: 'sites',
    depth: 0,
    limit: 1,
    where: { slug: { equals: slug } },
  })
  if (!docs[0]) throw new Error(`Site ${slug} missing — run \`pnpm seed\``)
  return docs[0] as Site
}

const upload = async (ownerSite: Site, folder?: string) => {
  const bytes = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 90, b: 140 } },
  }).png().toBuffer()
  const result = await payload.create({
    collection: 'media',
    data: { alt: 'Picker fixture', folder, site: siteIDOf(ownerSite) },
    file: { data: bytes, mimetype: 'image/png', name: `${uuid()}.png`, size: bytes.length },
    overrideAccess: true,
  })
  mediaIDs.push(String(result.id))
  return result
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  acme = await site('acme')
  studio = await site('studio')
  acmeOwner = await owner('acme@eshobe.test')
  studioOwner = await owner('studio-naghsh@eshobe.test')
}, 180_000)

afterEach(async () => {
  for (const id of productIDs.splice(0)) {
    await payload.delete({ collection: 'products', id, overrideAccess: true }).catch(() => undefined)
  }
  for (const id of mediaIDs.splice(0).reverse()) {
    await payload.delete({ collection: 'media', id, overrideAccess: true }).catch(() => undefined)
  }
  for (const id of folderIDs.splice(0).reverse()) {
    await payload.delete({ collection: 'payload-folders', id, overrideAccess: true }).catch(() => undefined)
  }
})

describe('tenant-aware media picker contracts', () => {
  it('allows a same-site selection and rejects a cross-site media relation even with access overridden', async () => {
    const image = await upload(acme)
    const title = `Picker ${uuid()}`

    const valid = await payload.create({
      collection: 'products',
      data: { image: image.id, price: 100, site: siteIDOf(acme), title },
      draft: true,
      locale: 'fa',
      overrideAccess: true,
    })
    productIDs.push(String(valid.id))
    expect(idOf(valid.image)).toBe(String(image.id))

    await expect(payload.create({
      collection: 'products',
      data: { image: image.id, price: 100, site: siteIDOf(studio), title: `${title} foreign` },
      draft: true,
      locale: 'fa',
      overrideAccess: true,
    })).rejects.toThrow('Media selections must belong to the current site.')
  })

  it('refuses to assign a folder from one tenant to another tenant’s media', async () => {
    const folder = await payload.create({
      collection: 'payload-folders',
      data: { folderType: ['media'], name: `Picker ${uuid()}`, site: siteIDOf(acme) },
      overrideAccess: true,
    })
    folderIDs.push(String(folder.id))

    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 90, g: 20, b: 140 } },
    }).png().toBuffer()

    await expect(payload.create({
      collection: 'media',
      data: { alt: 'Foreign folder', folder: folder.id, site: siteIDOf(studio) },
      file: { data: bytes, mimetype: 'image/png', name: `${uuid()}.png`, size: bytes.length },
      overrideAccess: true,
    })).rejects.toThrow('The selected folder does not belong to this site.')
  })

  it('still scopes the folder listing through normal tenant access', async () => {
    const folder = await payload.create({
      collection: 'payload-folders',
      data: { folderType: ['media'], name: `Private ${uuid()}`, site: siteIDOf(acme) },
      overrideAccess: true,
    })
    folderIDs.push(String(folder.id))

    const { docs } = await payload.find({
      collection: 'payload-folders',
      overrideAccess: false,
      pagination: false,
      user: studioOwner,
    })

    expect(docs.map((doc) => String(doc.id))).not.toContain(String(folder.id))
    expect(acmeOwner.role).toBe('user')
  })
})
