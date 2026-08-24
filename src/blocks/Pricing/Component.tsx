import React from 'react'

import type { PricingBlock as Props } from '@/payload-types'

import { CMSLink } from '@/components/Link'
import { formatNumber } from '@/lib/format'
import { getSiteContext } from '@/lib/site-context'
import { cn } from '@/utilities/ui'

/**
 * Async because the price has to be formatted for the active locale — `۲۹٬۰۰۰`
 * on `fa`, `29,000` on `en`. `getSiteContext` is `cache`d, so asking here costs
 * nothing over the page's own call.
 */
export const PricingBlock = async ({ heading, intro, plans }: Props) => {
  const { locale } = await getSiteContext()

  return (
    <section className="container">
      {(heading || intro) && (
        <div className="max-w-2xl mb-10">
          {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
          {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {plans?.map(({ id, name, enableLink, featured, features, link, period, price, unit }) => (
          <div
            className={cn(
              'flex flex-col rounded-lg border p-6',
              featured ? 'border-primary shadow-lg' : 'border-border',
            )}
            key={id}
          >
            <h3 className="text-lg font-semibold">{name}</h3>

            {typeof price === 'number' && (
              <p className="mt-4 flex flex-wrap items-baseline gap-x-2">
                <span className="text-3xl font-bold">{formatNumber(price, locale)}</span>
                {unit && <span className="text-muted-foreground">{unit}</span>}
                {period && <span className="text-sm text-muted-foreground">/ {period}</span>}
              </p>
            )}

            {features && features.length > 0 && (
              <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
                {features.map((feature, i) => (
                  <li className="flex gap-2" key={i}>
                    <span aria-hidden className="text-primary">
                      ✓
                    </span>
                    {feature}
                  </li>
                ))}
              </ul>
            )}

            {enableLink && link?.label && (
              <CMSLink
                appearance={featured ? 'default' : 'outline'}
                className="mt-6 w-full"
                {...link}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
