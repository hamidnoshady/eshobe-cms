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
  team: TeamBlock,
  testimonials: TestimonialsBlock,
}

export const RenderBlocks: React.FC<{
  blocks: Page['layout'][0][]
}> = (props) => {
  const { blocks } = props

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
                  <Block {...block} disableInnerContainer />
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
