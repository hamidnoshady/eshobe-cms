import React, { Fragment } from 'react'

import type { Page } from '@/payload-types'

import { ArchiveBlock } from '@/blocks/ArchiveBlock/Component'
import { CallToActionBlock } from '@/blocks/CallToAction/Component'
import { ContactBlockComponent } from '@/blocks/Contact/Component'
import { ContentBlock } from '@/blocks/Content/Component'
import { FAQBlockComponent } from '@/blocks/FAQ/Component'
import { FeaturesBlock } from '@/blocks/Features/Component'
import { FormBlock } from '@/blocks/Form/Component'
import { GalleryBlock } from '@/blocks/Gallery/Component'
import { LogosBlock } from '@/blocks/Logos/Component'
import { MediaBlock } from '@/blocks/MediaBlock/Component'
import { PricingBlock } from '@/blocks/Pricing/Component'
import { ProductGridBlock } from '@/blocks/ProductGrid/Component'
import { TeamBlock } from '@/blocks/Team/Component'
import { TestimonialsBlock } from '@/blocks/Testimonials/Component'

// Keys are block slugs. A block in `src/blocks/index.ts` with no entry here saves
// fine and renders nothing, so the two lists are checked against each other in
// `tests/int/blocks.int.spec.ts`.
const blockComponents = {
  archive: ArchiveBlock,
  contact: ContactBlockComponent,
  content: ContentBlock,
  cta: CallToActionBlock,
  faq: FAQBlockComponent,
  features: FeaturesBlock,
  formBlock: FormBlock,
  gallery: GalleryBlock,
  logos: LogosBlock,
  mediaBlock: MediaBlock,
  pricing: PricingBlock,
  productGrid: ProductGridBlock,
  team: TeamBlock,
  testimonials: TestimonialsBlock,
}

export const RenderBlocks: React.FC<{
  blocks: Page['layout'][0][]
  /**
   * The opaque Biza table token a café QR link carried (`?t=…`).
   *
   * Threaded rather than read from `headers()` inside the block: the page already has
   * the parsed `searchParams`, and a block that reads the request itself is a block that
   * cannot be rendered outside one (the café menu's own tests render it directly).
   * Only `productGrid` receives it — every other block would have to ignore an argument
   * it has no use for.
   */
  tableToken?: null | string
}> = (props) => {
  const { blocks, tableToken } = props

  const hasBlocks = blocks && Array.isArray(blocks) && blocks.length > 0

  if (hasBlocks) {
    return (
      <Fragment>
        {blocks.map((block, index) => {
          const { blockType } = block

          if (blockType && blockType in blockComponents) {
            const Block = blockComponents[blockType]

            if (Block) {
              return (
                <div className="my-16" key={index}>
                  {/* @ts-expect-error there may be some mismatch between the expected types here */}
                  <Block {...(blockType === 'productGrid' && tableToken ? { tableToken } : {})} {...block} disableInnerContainer />
                </div>
              )
            }
          }
          return null
        })}
      </Fragment>
    )
  }

  return null
}
