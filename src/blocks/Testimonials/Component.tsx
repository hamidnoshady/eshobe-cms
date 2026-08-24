import React from 'react'

import type { TestimonialsBlock as Props } from '@/payload-types'

import { Media } from '@/components/Media'

export const TestimonialsBlock: React.FC<Props> = ({ heading, intro, items }) => (
  <section className="container">
    {(heading || intro) && (
      <div className="max-w-2xl mb-10">
        {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
        {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
      </div>
    )}

    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {items?.map(({ author, avatar, id, quote, role }) => (
        <figure className="rounded-lg border border-border bg-card p-6" key={id}>
          {/* `border-s`, not `border-l`: the quote rule has to sit on the reading
              side, which is the right edge in Persian. */}
          <blockquote className="border-s-2 border-primary ps-4 text-card-foreground">
            {quote}
          </blockquote>
          <figcaption className="mt-4 flex items-center gap-3">
            {avatar && typeof avatar === 'object' && (
              <Media
                className="size-10 shrink-0 overflow-hidden rounded-full"
                imgClassName="size-10 object-cover"
                resource={avatar}
              />
            )}
            <div>
              <div className="font-medium">{author}</div>
              {role && <div className="text-sm text-muted-foreground">{role}</div>}
            </div>
          </figcaption>
        </figure>
      ))}
    </div>
  </section>
)
