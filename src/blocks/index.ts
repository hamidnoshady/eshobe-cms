import type { Block, BlocksField } from 'payload'

import type { Site } from '@/payload-types'

import { Archive } from './ArchiveBlock/config'
import { CallToAction } from './CallToAction/config'
import { Contact } from './Contact/config'
import { Content } from './Content/config'
import { FAQ } from './FAQ/config'
import { Features } from './Features/config'
import { FormBlock } from './Form/config'
import { Gallery } from './Gallery/config'
import { Logos } from './Logos/config'
import { MediaBlock } from './MediaBlock/config'
import { Pricing } from './Pricing/config'
import { ProductGrid } from './ProductGrid/config'
import { Team } from './Team/config'
import { Testimonials } from './Testimonials/config'

type SiteType = NonNullable<Site['type']>

const ALL: SiteType[] = ['business', 'portfolio', 'store']

/**
 * The block library, and which kinds of site may use each block.
 *
 * A typed table rather than a `custom` key on each block config: a misspelt site
 * type would silently hide a block from every site, and this way it does not
 * compile. `allowedBlocks` below turns it into the admin's block picker.
 */
const library: { block: Block; siteTypes: SiteType[] }[] = [
  { block: Content, siteTypes: ALL },
  { block: MediaBlock, siteTypes: ALL },
  { block: CallToAction, siteTypes: ALL },
  { block: Features, siteTypes: ALL },
  { block: Testimonials, siteTypes: ALL },
  { block: FAQ, siteTypes: ALL },
  { block: Contact, siteTypes: ALL },
  { block: FormBlock, siteTypes: ALL },
  // The store itself: a catalogue whose cards buy. Store-only, because a business
  // site selling one product has the pricing block, and a portfolio has the gallery.
  { block: ProductGrid, siteTypes: ['store'] },
  // A gallery is the point of a portfolio and a plausible "our work" section on a
  // business site.
  { block: Gallery, siteTypes: ['portfolio', 'business'] },
  { block: Team, siteTypes: ['business', 'portfolio'] },
  { block: Pricing, siteTypes: ['business', 'store'] },
  { block: Logos, siteTypes: ['business', 'store'] },
  { block: Archive, siteTypes: ['business', 'portfolio'] },
]

/** Every block the `layout` field can hold, before the per-site filter. */
export const siteBlocks: Block[] = library.map(({ block }) => block)

export const blockSlugsForSiteType = (type: null | string | undefined): string[] =>
  library
    .filter(({ siteTypes }) => !type || siteTypes.includes(type as SiteType))
    .map(({ block }) => block.slug)

/**
 * Narrows the block picker to what this site's type allows, and — because Payload
 * re-checks `filterOptions` on save — rejects a block that does not belong even if
 * it arrives over the REST API.
 */
export const allowedBlocks: NonNullable<BlocksField['filterOptions']> = async ({ data, req }) => {
  const site = data?.site
  const id = typeof site === 'object' && site !== null ? site.id : site

  if (!id) return true

  const doc = await req.payload.findByID({
    id,
    collection: 'sites',
    // `disableErrors` rather than a try/catch: if the editor cannot read the site,
    // the safe answer is every block — the wrong block on a page is a cosmetic
    // problem, an uneditable page is not.
    depth: 0,
    disableErrors: true,
    overrideAccess: false,
    req,
    select: { type: true },
  })

  return blockSlugsForSiteType(doc?.type)
}
