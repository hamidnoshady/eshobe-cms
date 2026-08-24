import React from 'react'

import type { TeamBlock as Props } from '@/payload-types'

import { Media } from '@/components/Media'
import { cn } from '@/utilities/ui'

import { columnClass } from '../fields'

export const TeamBlock: React.FC<Props> = ({ columns, heading, intro, members }) => (
  <section className="container">
    {(heading || intro) && (
      <div className="max-w-2xl mb-10">
        {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
        {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
      </div>
    )}

    <div className={cn('grid gap-8', columnClass[columns ?? '3'])}>
      {members?.map(({ id, bio, name, photo, role }) => (
        <div key={id}>
          {photo && typeof photo === 'object' && (
            <Media
              className="mb-4 aspect-square overflow-hidden rounded-lg"
              imgClassName="size-full object-cover"
              resource={photo}
            />
          )}
          <h3 className="font-semibold">{name}</h3>
          {role && <div className="text-sm text-primary">{role}</div>}
          {bio && <p className="mt-2 text-sm text-muted-foreground">{bio}</p>}
        </div>
      ))}
    </div>
  </section>
)
