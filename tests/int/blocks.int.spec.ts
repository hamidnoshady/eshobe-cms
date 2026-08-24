import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { Field } from 'payload'

import { blockSlugsForSiteType, siteBlocks } from '@/blocks'

/**
 * The block library is two lists that have to agree: `src/blocks/index.ts` decides
 * what an editor may add, `RenderBlocks.tsx` decides what the site draws. A block in
 * the first and not the second saves cleanly and renders nothing — no error, just a
 * blank space on a customer's page.
 */
const renderedSlugs = (): string[] => {
  const source = readFileSync('src/blocks/RenderBlocks.tsx', 'utf8')
  const map = source.match(/const blockComponents = \{([^}]*)\}/)

  if (!map) throw new Error('blockComponents map not found — did RenderBlocks.tsx move?')

  return [...map[1]!.matchAll(/^\s*(\w+):/gm)].map(([, slug]) => slug!)
}

describe('block library', () => {
  it('renders every block it lets an editor add', () => {
    expect(renderedSlugs().sort()).toEqual(siteBlocks.map(({ slug }) => slug).sort())
  })

  it('has no duplicate slug', () => {
    // Two blocks on one slug silently shadow each other in the picker.
    const slugs = siteBlocks.map(({ slug }) => slug)

    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('localizes the text inside blocks and never the layout array', () => {
    // Localizing a container gives each locale its own set of blocks, so editors
    // would rebuild the page per language (PLAN §3.7). Recursive because the fields
    // that matter sit inside an array, inside a row.
    const flatten = (fields: Field[]): Field[] =>
      fields.flatMap((field) => ('fields' in field ? flatten(field.fields) : field))

    const prose = flatten(siteBlocks.flatMap(({ fields }) => fields)).filter(
      (field) => 'name' in field && ['text', 'textarea'].includes(field.type),
    )

    expect(prose.length).toBeGreaterThan(10)
    expect(
      prose
        .filter((field) => !('localized' in field && field.localized))
        // A phone number is the same number in every language.
        .map((field) => ('name' in field ? field.name : '')),
    ).toEqual(['phones'])
  })

  it('offers a store no gallery or team, and a portfolio no price list', () => {
    const store = blockSlugsForSiteType('store')
    const portfolio = blockSlugsForSiteType('portfolio')

    expect(store).not.toContain('gallery')
    expect(store).not.toContain('team')
    expect(store).toContain('pricing')

    expect(portfolio).toContain('gallery')
    expect(portfolio).not.toContain('pricing')
  })

  it('offers every block when the site type is unknown', () => {
    // `filterOptions` runs before the tenant is set on a brand-new page; hiding
    // everything there would leave the editor unable to build anything.
    expect(blockSlugsForSiteType(null)).toHaveLength(siteBlocks.length)
    expect(blockSlugsForSiteType(undefined)).toHaveLength(siteBlocks.length)
  })

  it('offers the shared blocks to all three site types', () => {
    for (const slug of ['content', 'cta', 'features', 'faq', 'contact']) {
      for (const type of ['business', 'portfolio', 'store']) {
        expect(blockSlugsForSiteType(type)).toContain(slug)
      }
    }
  })
})
