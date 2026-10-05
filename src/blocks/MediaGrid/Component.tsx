import React from 'react'

import type { MediaGridBlock as MediaGridProps } from '@/payload-types'
import { cn } from '@/utilities/ui'

import { Media } from '../../components/Media'

/** Built-in renderer for the rich-text image row: one shared ratio, 2–4 columns. */
export const MediaGridBlock: React.FC<MediaGridProps & { className?: string }> = ({
  aspect,
  caption,
  className,
  columns,
  images,
}) => {
  const items = (images ?? []).filter((image) => image && typeof image === 'object')
  if (items.length === 0) return null
  const ratio = (aspect ?? '4/5').replace('/', ' / ')

  return (
    <figure className={cn('my-8', className)}>
      <div
        className={cn('grid grid-cols-2 gap-3', {
          'md:grid-cols-3': columns === '3',
          'md:grid-cols-4': columns === '4',
        })}
      >
        {items.map((image, index) => (
          <div
            className="relative overflow-hidden rounded-[0.8rem] border border-border"
            key={typeof image === 'object' ? image.id : index}
            style={{ aspectRatio: ratio }}
          >
            <Media fill imgClassName="object-cover" resource={image} />
          </div>
        ))}
      </div>
      {caption ? <figcaption className="mt-3 text-sm text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  )
}
