// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const root = path.resolve(process.cwd(), 'demo-packs')

describe('demo packs', () => {
  for (const key of readdirSync(root)) {
    it(`${key}: pack.json is coherent and every image exists`, () => {
      const pack = JSON.parse(readFileSync(path.join(root, key, 'pack.json'), 'utf8'))
      expect(pack.key).toBe(key)
      const cats = new Set(pack.categories.map((c: { slug: string }) => c.slug))
      for (const p of pack.posts) {
        expect(cats.has(p.category), `${p.slug} category`).toBe(true)
        expect(existsSync(path.join(root, key, 'images', p.image)), `${p.slug} image`).toBe(true)
        expect(p.title.fa && p.title.en, `${p.slug} titles`).toBeTruthy()
      }
    })
  }
})
