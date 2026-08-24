import React from 'react'

import type { GalleryBlock as Props } from '@/payload-types'

import { Media } from '@/components/Media'
import { cn } from '@/utilities/ui'

import { columnClass } from '../fields'

export const GalleryBlock: React.FC<Props> = ({ columns, heading, images, intro }) => (
  <section className="container">
    {(heading || intro) && (
      <div className="max-w-2xl mb-10">
        {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
        {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
      </div>
    )}

    <div className={cn('grid gap-4', columnClass[columns ?? '3'])}>
      {images?.map((image) =>
        typeof image === 'object' ? (
          <figure key={image.id}>
            <Media
              className="overflow-hidden rounded-lg border border-border"
              imgClassName="w-full h-auto"
              resource={image}
            />
          </figure>
        ) : null,
      )}
    </div>
  </section>
)
