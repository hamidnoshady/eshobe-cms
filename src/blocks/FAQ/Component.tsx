import React from 'react'

import type { FAQBlock as Props } from '@/payload-types'

/**
 * `<details>`/`<summary>`, not an accordion component: the native element is
 * keyboard-operable and announced correctly with no JavaScript, and its `::marker`
 * already flips to the reading side in RTL.
 */
export const FAQBlockComponent: React.FC<Props> = ({ heading, intro, items }) => (
  <section className="container">
    {(heading || intro) && (
      <div className="max-w-2xl mb-10">
        {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
        {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
      </div>
    )}

    <div className="max-w-3xl divide-y divide-border border-y border-border">
      {items?.map(({ id, answer, question }) => (
        <details className="group py-4" key={id}>
          <summary className="cursor-pointer font-medium marker:text-primary">{question}</summary>
          <p className="mt-3 text-muted-foreground">{answer}</p>
        </details>
      ))}
    </div>
  </section>
)
