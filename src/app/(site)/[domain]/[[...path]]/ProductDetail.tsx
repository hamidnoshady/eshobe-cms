import { draftMode } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import React from 'react'

import { Media } from '@/components/Media'
import { LivePreviewListener } from '@/components/LivePreviewListener'
import { formatPrice } from '@/lib/format'
import { menuAvailability } from '@/lib/cafe-menu'
import { getSiteContext } from '@/lib/site-context'
import { paymentMethodsForSite, storeSettingsForSite } from '@/lib/store'
import { uiString } from '@/lib/ui-strings'
import { cn } from '@/utilities/ui'

import { PurchaseForm } from '@/blocks/ProductGrid/PurchaseForm'
import { CafeMenuClient } from '@/blocks/ProductGrid/CafeMenuClient'
import { queryProduct } from './queries'

/**
 * A product page. For a variable product, `?variant=<key>` selects the exact variation
 * Torob's feed linked to (issue #183): price, stock and image come from that row, and the
 * purchase form sends the same key to checkout. Without a key the page shows the first
 * active variation so a shared parent URL is still buyable.
 */
export const ProductDetail: React.FC<{ slug: string; variantKey?: string }> = async ({ slug, variantKey }) => {
  const { isEnabled: draft } = await draftMode()
  const { locale, site } = await getSiteContext()
  const product = await queryProduct(slug)

  if (!product) notFound()

  const { currency } = site
    ? await storeSettingsForSite(String(site.id), { cachePublic: !draft, locale })
    : { currency: 'IRT' as const }

  const paymentMethods = site
    ? await paymentMethodsForSite(String(site.id), { currency, locale })
    : []

  const activeVariations = (product.variations ?? []).filter((variation) => variation.active !== false && variation.key)
  const isVariable = (product.productType ?? 'simple') === 'variable'
  const variation = isVariable
    ? activeVariations.find((candidate) => candidate.key === variantKey) ?? activeVariations[0]
    : undefined
  if (isVariable && !variation) notFound()

  const price = variation?.price ?? product.price
  const compareAtPrice = variation?.compareAtPrice ?? product.compareAtPrice
  const image = variation?.image ?? product.image
  const stockRow = variation?.trackInventory ? variation : product
  const stock =
    stockRow.trackInventory && typeof stockRow.inventory === 'number'
      ? Math.max(0, stockRow.inventory)
      : null
  const availability = menuAvailability({ menuAvailability: product.menuAvailability, inventory: stockRow.inventory, trackInventory: stockRow.trackInventory })
  const soldOut = availability !== 'available'
  const hasModifiers = (product.modifierGroups ?? []).some((group) => group.active !== false)

  return (
    <article className="pb-24">
      {draft && <LivePreviewListener />}

      <div className="container pt-16">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
            {image ? (
              <Media
                resource={image}
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
                {uiString(availability === 'sold_out' ? 'outOfStock' : 'unavailable', locale)}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <h1 className="text-3xl font-bold">
              {product.title}
              {variation?.label ? ` — ${variation.label}` : ''}
            </h1>

            {product.summary && <p className="text-muted-foreground">{product.summary}</p>}

            {isVariable && activeVariations.length > 1 && (
              <nav aria-label={uiString('chooseOptions', locale)} className="flex flex-wrap gap-2">
                {activeVariations.map((candidate) => (
                  <Link
                    className={cn(
                      'rounded-md border px-3 py-1 text-sm',
                      candidate.key === variation?.key
                        ? 'border-primary bg-primary/5 font-medium'
                        : 'border-border hover:bg-muted/50',
                    )}
                    href={`?variant=${encodeURIComponent(candidate.key!)}`}
                    key={candidate.key}
                  >
                    {candidate.label ?? candidate.key}
                  </Link>
                ))}
              </nav>
            )}

            <p className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-2xl font-bold">{formatPrice(price, currency, locale)}</span>
              {typeof compareAtPrice === 'number' && compareAtPrice > Number(price ?? 0) && (
                <s className="text-base text-muted-foreground">
                  {formatPrice(compareAtPrice, currency, locale)}
                </s>
              )}
            </p>

            {product.sku && (
              <p className="text-sm text-muted-foreground">
                {uiString('sku', locale)}: {variation?.sku ?? product.sku}
              </p>
            )}

            {!soldOut ? (
              hasModifiers ? (
                <CafeMenuClient
                  key={`${product.id}-${variation?.key ?? ''}`}
                  categories={[]}
                  compact
                  currency={currency}
                  locale={locale}
                  paymentMethods={paymentMethods}
                  products={[{
                    id: String(product.id), title: product.title, price: product.price,
                    image: null, menuAvailability: product.menuAvailability, productType: product.productType,
                    trackInventory: product.trackInventory, inventory: product.inventory, categoryIds: [],
                    modifierGroups: product.modifierGroups ?? [],
                    variations: [...activeVariations].sort((a, b) => a.key === variation?.key ? -1 : b.key === variation?.key ? 1 : 0).map((item) => ({
                      key: item.key!, label: item.label || item.key!, price: item.price,
                      trackInventory: item.trackInventory, inventory: item.inventory,
                    })),
                  }]}
                  showBuyButton
                />
              ) : (
                <PurchaseForm
                  availability={stock}
                  currency={currency}
                  locale={locale}
                  paymentMethods={paymentMethods}
                  productId={String(product.id)}
                  variation={variation?.key ?? undefined}
                />
              )
            ) : (
              <p className="rounded-md border border-border bg-muted p-4 text-center text-sm">
                {uiString(availability === 'sold_out' ? 'outOfStock' : 'unavailable', locale)}
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
