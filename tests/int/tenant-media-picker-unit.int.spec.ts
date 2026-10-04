import type { Field } from 'payload'

import { describe, expect, it } from 'vitest'
import { collectTenantMediaIDs } from '@/plugins/tenant-media-picker'

const fieldSchema = [
  {
    type: 'tabs',
    tabs: [
      { name: 'meta', fields: [{ name: 'image', type: 'upload', relationTo: 'media' }] },
    ],
  },
  {
    name: 'layout',
    type: 'blocks',
    blocks: [
      {
        slug: 'gallery',
        fields: [{ name: 'images', type: 'upload', relationTo: 'media', hasMany: true }],
      },
    ],
  },
  { name: 'content', type: 'richText' },
] as unknown as Field[]

describe('tenant media reference traversal', () => {
  it('finds upload references in SEO tabs, nested blocks and Lexical MediaBlock nodes', () => {
    const ids = collectTenantMediaIDs(fieldSchema, {
      meta: { image: 'seo-image-id' },
      layout: [{ blockType: 'gallery', images: ['gallery-a', { id: 'gallery-b' }] }],
      content: {
        root: {
          children: [
            { type: 'block', fields: { blockType: 'mediaBlock', media: { id: 'lexical-image-id' } } },
            { type: 'block', fields: { blockType: 'other', media: 'not-a-media-block' } },
          ],
        },
      },
    })

    expect(ids.sort()).toEqual(['gallery-a', 'gallery-b', 'lexical-image-id', 'seo-image-id'].sort())
  })
})
