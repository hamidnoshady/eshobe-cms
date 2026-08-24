import React from 'react'

import type { LogosBlock as Props } from '@/payload-types'

import { Media } from '@/components/Media'

export const LogosBlock: React.FC<Props> = ({ heading, intro, logos }) => (
  <section className="container">
    {(heading || intro) && (
      <div className="max-w-2xl mb-8 text-center mx-auto">
        {heading && <h2 className="text-2xl font-bold">{heading}</h2>}
        {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
      </div>
    )}

    <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-8">
      {logos?.map((logo) =>
        typeof logo === 'object' ? (
          <Media
            className="h-10 w-auto opacity-70 grayscale transition hover:opacity-100 hover:grayscale-0"
            imgClassName="h-10 w-auto object-contain"
            key={logo.id}
            resource={logo}
          />
        ) : null,
      )}
    </div>
  </section>
)
