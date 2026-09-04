import type { ProductGridBlock as Props } from '@/payload-types'

import React from 'react'

import Link from 'next/link'

import type { Product } from '@/payload-types'

import { Media } from '@/components/Media'
import { MAX_ORDER_QUANTITY } from '@/lib/checkout'
import { formatPrice } from '@/lib/format'
import { idOf } from '@/lib/ids'
import { localeHref } from '@/lib/locales'
import { getSiteContext } from '@/lib/site-context'
import { findForSite } from '@/lib/site-query'
import { storeSettingsForSite } from '@/lib/store'
import { uiString } from '@/lib/ui-strings'
import { productPath } from '@/lib/slug'
import { cn } from '@/utilities/ui'

import { columnClass } from '../fields'
import { PurchaseForm } from './PurchaseForm'

const available = (product: Product): null | number =>
  product.trackInventory && typeof product.inventory === 'number'
    ? Math.max(0, Math.min(MAX_ORDER_QUANTITY, product.inventory))
    : null

export const ProductGridBlock: React.FC<Props> = async ({
  columns,
  heading,
  intro,
  limit,
  populateBy,
  products: selected,
  showBuyButton,
}) => {
  const { locale, site } = await getSiteContext()

  // The site is what makes a price mean anything: the currency is a property of the
  // store, and a price without its unit is an order of magnitude waiting to happen.
  const { currency } = site
    ? await storeSettingsForSite(String(site.id), { locale })
    : { currency: 'IRT' as const }

  let items: Product[] = []

  if (populateBy === 'selection' && selected?.length) {
    // A `hasMany` relationship to one collection populates to the docs themselves —
    // the `{ relationTo, value }` shape only appears on a `relationTo: []` field.
    items = selected.filter((item): item is Product => typeof item === 'object')
  } else if (site) {
    // `findForSite`, never `payload.find`: this renders on a public page, where the
    // Local API would otherwise hand every other customer's catalogue to this one —
    // and their drafts too, because `draft: false` does not filter drafts.
    const { docs } = await findForSite('products', String(site.id), {
      limit: limit ?? 6,
      locale,
      sort: '-createdAt',
      where: { _status: { equals: 'published' } },
    })

    items = docs
  }

  if (populateBy === 'selection') {
    // A hand-written or imported `layout` can name any product id, and the tenant
    // filter on a relationship is applied to the *document's* site — which for a
    // block inside a page is the page's. Re-checking here is two lines and closes
    // the difference between "the admin picker prevents it" and "the render does".
    items = items.filter((item) => idOf(item.site) === idOf(site?.id))
  }

  if (!items.length) return null

  return (
    <section className="container">
      {(heading || intro) && (
        <div className="max-w-2xl mb-10">
          {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
          {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
        </div>
      )}

      <div className={cn('grid items-start gap-6', columnClass[columns ?? '3'])}>
        {items.map((product) => {
          const stock = available(product)
          const soldOut = stock === 0

          return (
            <article
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
              key={String(product.id)}
            >
              <div className="relative aspect-square w-full bg-muted">
                {product.image && (
                  <Media
                    className="h-full w-full"
                    imgClassName="h-full w-full object-cover"
                    resource={product.image}
                    size="33vw"
                  />
                )}
                {soldOut && (
                  <span className="absolute end-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-muted-foreground">
                    {uiString('outOfStock', locale)}
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col gap-3 p-4">
                <Link
                  href={localeHref(productPath(product.slug), locale, site?.defaultLocale ?? 'fa')}
                  className="hover:underline"
                >
                  <h3 className="text-lg leading-snug font-semibold">{product.title}</h3>
                </Link>

                {product.summary && (
                  <p className="text-sm text-muted-foreground">{product.summary}</p>
                )}

                <p className="mt-auto flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xl font-bold">
                    {formatPrice(product.price, currency, locale)}
                  </span>
                  {typeof product.compareAtPrice === 'number' &&
                    product.compareAtPrice > Number(product.price ?? 0) && (
                      <s className="text-sm text-muted-foreground">
                        {formatPrice(product.compareAtPrice, currency, locale)}
                      </s>
                    )}
                </p>

                {showBuyButton !== false && !soldOut && (
                  <PurchaseForm
                    availability={stock}
                    locale={locale}
                    productId={String(product.id)}
                  />
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
