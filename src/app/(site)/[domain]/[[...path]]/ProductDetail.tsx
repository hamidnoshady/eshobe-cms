import { draftMode } from 'next/headers'
import { notFound } from 'next/navigation'
import React from 'react'

import { Media } from '@/components/Media'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { formatPrice } from '@/lib/format'
import { getSiteContext } from '@/lib/site-context'
import { storeSettingsForSite } from '@/lib/store'
import { uiString } from '@/lib/ui-strings'

import { PurchaseForm } from '@/blocks/ProductGrid/PurchaseForm'
import { queryProduct } from './queries'

export const ProductDetail: React.FC<{ slug: string }> = async ({ slug }) => {
  const { isEnabled: draft } = await draftMode()
  const { locale, site } = await getSiteContext()
  const product = await queryProduct(slug)

  if (!product) notFound()

  const { currency } = site
    ? await storeSettingsForSite(String(site.id), { locale })
    : { currency: 'IRT' as const }

  const stock =
    product.trackInventory && typeof product.inventory === 'number'
      ? Math.max(0, product.inventory)
      : null
  const soldOut = stock === 0

  return (
    <article className="pb-24">
      {draft && <LivePreviewListener />}

      <div className="container pt-16">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
            {product.image ? (
              <Media
                resource={product.image}
                className="h-full w-full"
                imgClassName="h-full w-full object-cover"
                size="50vw"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                {uiString('noImage', locale)}
              </div>
            )}
            {soldOut && (
              <span className="absolute end-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-muted-foreground">
                {uiString('outOfStock', locale)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <h1 className="text-3xl font-bold">{product.title}</h1>

            {product.summary && <p className="text-muted-foreground">{product.summary}</p>}

            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-2xl font-bold">{formatPrice(product.price, currency, locale)}</span>
              {typeof product.compareAtPrice === 'number' &&
                product.compareAtPrice > Number(product.price ?? 0) && (
                  <s className="text-base text-muted-foreground">
                    {formatPrice(product.compareAtPrice, currency, locale)}
                  </s>
                )}
            </p>

            {product.sku && (
              <p className="text-sm text-muted-foreground">
                {uiString('sku', locale)}: {product.sku}
              </p>
            )}

            {!soldOut ? (
              <PurchaseForm
                availability={stock}
                locale={locale}
                productId={String(product.id)}
              />
            ) : (
              <p className="rounded-md border border-border bg-muted p-4 text-center text-sm">
                {uiString('outOfStock', locale)}
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
