import type { StaticImageData } from 'next/image'

import { cn } from '@/utilities/ui'
import React from 'react'
import RichText from '@/components/RichText'

import type { MediaBlock as MediaBlockProps, MediaBlockInline } from '@/payload-types'

import { Media } from '../../components/Media'

type Props = (MediaBlockProps | MediaBlockInline) & {
  breakout?: boolean
  captionClassName?: string
  className?: string
  enableGutter?: boolean
  imgClassName?: string
  staticImage?: StaticImageData
  disableInnerContainer?: boolean
}

export const MediaBlock: React.FC<Props> = (props) => {
  const {
    captionClassName,
    className,
    enableGutter = true,
    imgClassName,
    media,
    staticImage,
    disableInnerContainer,
    aspect,
    size,
  } = props

  // The block's own caption wins; older rows fall back to the medium's rich caption.
  const blockCaption = typeof props.caption === 'string' && props.caption.trim() ? props.caption : null
  let caption
  if (!blockCaption && media && typeof media === 'object') caption = media.caption
  const ratio = aspect && aspect !== 'auto' && aspect !== 'original' ? aspect.replace('/', ' / ') : undefined

  return (
    <div
      className={cn(
        '',
        {
          container: enableGutter,
          'mx-auto max-w-xl': size === 'narrow',
          'mx-auto max-w-3xl': size === 'content',
        },
        className,
      )}
    >
      {(media || staticImage) &&
        (ratio ? (
          <div className="relative overflow-hidden rounded-[0.8rem] border border-border" style={{ aspectRatio: ratio }}>
            <Media fill imgClassName={cn('object-cover', imgClassName)} resource={media} src={staticImage} />
          </div>
        ) : (
          <Media
            imgClassName={cn('border border-border rounded-[0.8rem] max-h-[75svh] w-auto mx-auto object-contain', imgClassName)}
            resource={media}
            src={staticImage}
          />
        ))}
      {blockCaption && (
        <p className={cn('mt-3 text-sm text-muted-foreground', captionClassName)}>{blockCaption}</p>
      )}
      {caption && (
        <div
          className={cn(
            'mt-6',
            {
              container: !disableInnerContainer,
            },
            captionClassName,
          )}
        >
          <RichText data={caption} enableGutter={false} />
        </div>
      )}
    </div>
  )
}
