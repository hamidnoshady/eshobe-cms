import React from 'react'

import type { FeaturesBlock as Props } from '@/payload-types'

import { Media } from '@/components/Media'
import { cn } from '@/utilities/ui'

import { columnClass } from '../fields'

export const FeaturesBlock: React.FC<Props> = ({ columns, heading, intro, items }) => (
  <section className="container">
    {(heading || intro) && (
      <div className="max-w-2xl mb-10">
        {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
        {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
      </div>
    )}

    <div className={cn('grid gap-8', columnClass[columns ?? '3'])}>
      {items?.map(({ description, icon, id, title }) => (
        <div key={id}>
          {icon && typeof icon === 'object' && (
            <Media className="mb-4 size-10" imgClassName="size-10 object-contain" resource={icon} />
          )}
          <h3 className="text-lg font-semibold">{title}</h3>
          {description && <p className="mt-2 text-muted-foreground">{description}</p>}
        </div>
      ))}
    </div>
  </section>
)
