// @vitest-environment node
// Uploads need Node's own Buffer realm (see uploads.int.spec.ts).
import type { Block, Field, Payload } from 'payload'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPayload } from 'payload'
import sharp from 'sharp'

import config from '@/payload.config'
import { Content } from '@/blocks/Content/config'
import { MediaBlock, MediaBlockInline } from '@/blocks/MediaBlock/config'
import { MediaGrid } from '@/blocks/MediaGrid/config'

/**
 * The page builder's layout controls: how a photograph sits (width, frame ratio,
 * caption), an image row inside articles, and quarter-width columns.
 *
 * The property worth pinning is localization: a page layout row localizes its caption
 * (the `layout` array itself never is), while the rich-text variant must not, because
 * the whole rich-text field is already localized.
 *
 * Run `pnpm seed` first.
 */

const flatten = (fields: Field[]): Field[] =>
  fields.flatMap((field) => ('fields' in field && !('name' in field) ? flatten(field.fields as Field[]) : [field]))

const named = (block: Block, name: string) =>
  flatten(block.fields).find((field) => 'name' in field && field.name === name) as
    | (Field & { localized?: boolean; options?: { value: string }[] })
    | undefined

describe('block definitions', () => {
  it('localizes the caption on page rows only', () => {
    expect(named(MediaBlock, 'caption')?.localized).toBe(true)
    // Payload's sanitizer deletes `localized: false`, so assert "not localized".
    expect(named(MediaBlockInline, 'caption')?.localized).not.toBe(true)
    expect(MediaBlock.slug).toBe(MediaBlockInline.slug)
  })

  it('offers every frame size and ratio the themes understand', () => {
    expect(named(MediaBlock, 'size')?.options?.map((option) => option.value)).toEqual(['narrow', 'content', 'wide', 'full'])
    expect(named(MediaBlock, 'aspect')?.options?.map((option) => option.value)).toContain('original')
    // A grid shares one ratio; a ragged row is exactly what it exists to avoid.
    expect(named(MediaGrid, 'aspect')?.options?.map((option) => option.value)).not.toContain('original')
  })

  it('has quarter-width content columns', () => {
    const columns = named(Content, 'columns') as unknown as { fields: Field[] }
    const size = flatten(columns.fields).find((field) => 'name' in field && field.name === 'size') as {
      options: { value: string }[]
    }
    expect(size.options.map((option) => option.value)).toEqual([
      'oneQuarter',
      'oneThird',
      'half',
      'twoThirds',
      'threeQuarters',
      'full',
    ])
  })
})

describe('a media row in a page layout', () => {
  let payload: Payload
  let pageId = ''
  let mediaId = ''

  beforeAll(async () => {
    payload = await getPayload({ config })
  })

  afterAll(async () => {
    if (pageId) await payload.delete({ collection: 'pages', context: { disableRevalidate: true }, id: pageId })
    if (mediaId) await payload.delete({ collection: 'media', id: mediaId, overrideAccess: true })
  })

  it('stores size and ratio once and the caption per locale', async () => {
    const { docs: sites } = await payload.find({ collection: 'sites', limit: 1, where: { domain: { equals: 'studio.localhost' } } })
    if (!sites[0]) throw new Error('studio.localhost missing — run `pnpm seed`')
    const site = sites[0]
    const bytes = await sharp({
      create: { background: '#888888', channels: 3, height: 40, width: 32 },
    })
      .png()
      .toBuffer()
    const medium = await payload.create({
      collection: 'media',
      data: { alt: 'page builder fixture', site: site.id },
      file: { data: bytes, mimetype: 'image/png', name: `page-builder-${Date.now()}.png`, size: bytes.length },
      overrideAccess: true,
    })
    mediaId = String(medium.id)
    const media = [medium]

    const created = await payload.create({
      collection: 'pages',
      context: { disableRevalidate: true },
      data: {
        hero: { type: 'none' },
        layout: [{ aspect: '4/5', blockType: 'mediaBlock', caption: 'نمای شمالی', media: media[0].id, size: 'wide' }],
        site: site.id,
        slug: 'page-builder-media-test',
        title: 'آزمون چیدمان',
      },
      locale: 'fa',
    })
    pageId = String(created.id)
    const row = created.layout?.[0] as { id?: string }

    // A second-locale write keeps the row id, so it is a translation, not a rewrite.
    await payload.update({
      collection: 'pages',
      context: { disableRevalidate: true },
      data: { layout: [{ ...row, blockType: 'mediaBlock', caption: 'North elevation' }], slug: 'page-builder-media-test', title: 'Layout test' },
      id: pageId,
      locale: 'en',
    })

    const fa = await payload.findByID({ collection: 'pages', depth: 0, id: pageId, locale: 'fa' })
    const en = await payload.findByID({ collection: 'pages', depth: 0, id: pageId, locale: 'en' })
    expect(fa.layout?.[0]).toMatchObject({ aspect: '4/5', caption: 'نمای شمالی', size: 'wide' })
    expect(en.layout?.[0]).toMatchObject({ aspect: '4/5', caption: 'North elevation', size: 'wide' })
  })
})
