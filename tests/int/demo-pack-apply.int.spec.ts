// @vitest-environment node
import type { Payload, PayloadRequest } from 'payload'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalReq, getPayload } from 'payload'

import config from '@/payload.config'
import { applyDemoPack } from '@/platform/demoPacks'

/**
 * The Graphite pack, installed into a real (empty) portfolio site. The theme fills its
 * section routes from pages whose slug is the section key, so a pack that seeds posts
 * but no pages leaves `/about`, `/services` and `/contact` empty. Run `pnpm seed` first.
 */
const DOMAIN = 'demo-pack.localhost'
const noRevalidate = { disableRevalidate: true }

let payload: Payload
let req: PayloadRequest
let site: Record<string, unknown>

const plain = (value: unknown): string => JSON.stringify(value ?? '')

const teardown = async () => {
  const { docs } = await payload.find({ collection: 'sites', overrideAccess: true, where: { domain: { equals: DOMAIN } } })
  for (const s of docs) {
    for (const collection of ['posts', 'pages', 'categories', 'media', 'header', 'footer', 'theme', 'forms'] as const) {
      await payload.delete({ collection, context: noRevalidate, overrideAccess: true, where: { site: { equals: s.id } } })
    }
    await payload.delete({ collection: 'sites', id: s.id, overrideAccess: true })
  }
}

beforeAll(async () => {
  payload = await getPayload({ config: await config })
  await teardown()
  req = await createLocalReq({}, payload)
  site = (await payload.create({
    collection: 'sites',
    data: { availableLocales: ['fa', 'en'], defaultLocale: 'fa', domain: DOMAIN, name: 'گرافیت آزمایشی', status: 'active', type: 'portfolio' },
    overrideAccess: true,
  } as never)) as unknown as Record<string, unknown>
})

afterAll(async () => {
  await teardown()
})

describe('graphite demo pack', () => {
  it('creates the section pages in both locales without losing the Persian text', async () => {
    const result = await applyDemoPack(req, site, 'graphite', false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary.pages).toBe(4)
    expect(result.summary.categories).toBe(2)

    const read = (locale: 'en' | 'fa') =>
      payload.find({
        collection: 'pages',
        depth: 0,
        fallbackLocale: false,
        locale,
        overrideAccess: true,
        pagination: false,
        where: { site: { equals: site.id } },
      } as never)

    const fa = (await read('fa')).docs as unknown as Record<string, unknown>[]
    const en = (await read('en')).docs as unknown as Record<string, unknown>[]
    expect(fa.map((p) => p.slug).sort()).toEqual(['about', 'contact', 'home', 'services'])
    expect(en.map((p) => p.slug).sort()).toEqual(['about', 'contact', 'home', 'services'])

    for (const page of fa) expect(page._status).toBe('published')
    const aboutFa = fa.find((p) => p.slug === 'about')!
    const aboutEn = en.find((p) => p.slug === 'about')!
    expect(aboutFa.title).toBe('درباره ما')
    expect(aboutEn.title).toBe('About')
    // The English write kept the Persian rows (same row ids), not replaced them.
    expect(plain(aboutFa.layout)).toContain('گرافیت دفتری کوچک')
    expect(plain(aboutEn.layout)).toContain('small Tehran studio')

    const contact = (fa.find((p) => p.slug === 'contact')!.layout as Record<string, unknown>[]).find(
      (b) => b.blockType === 'contact',
    )!
    expect(contact.latitude).toBeCloseTo(35.7448)
  })

  it('adds nothing on a second run', async () => {
    const again = await applyDemoPack(req, site, 'graphite', false)
    expect(again.ok && again.summary).toMatchObject({ categories: 0, media: 0, pages: 0, posts: 0 })
  })
})
