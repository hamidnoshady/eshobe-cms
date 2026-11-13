import React from 'react'

import type { TypedLocale } from 'payload'
import type { CurrencyCode } from '@/lib/money'
import type { PaymentMethodOption } from '@/lib/checkout'

import { Media } from '@/components/Media'
import { CAFE_MENU_TAXONOMY, menuSort } from '@/lib/cafe-menu'
import { isTableToken } from '@/lib/cafe-order'
import { idOf } from '@/lib/ids'
import { findForSite } from '@/lib/site-query'

import { CafeMenuClient } from './CafeMenuClient'
import type { CafeMenuCategory, CafeMenuItem } from './cafeTypes'

/**
 * Public reads are scoped and uncached: POS availability may change at any moment.
 *
 * `tableToken` arrives from the page's search params — a QR link Biza printed as
 * `/menu?t=<opaque>` — and is passed through untouched. It is validated for *shape* only
 * (so a hand-typed `?t=…` cannot inject something that overflows a column or a webhook
 * body); whether it names a real table is Biza's question, answered when the order is
 * submitted, and it is answered per order rather than per page view because a table can
 * be closed between the scan and the order.
 */
export const CafeMenu = async ({ currency, heading, intro, locale, paymentMethods, showBuyButton, siteId, tableToken }: {
  currency: CurrencyCode
  heading?: string | null
  intro?: string | null
  locale: TypedLocale
  paymentMethods: PaymentMethodOption[]
  showBuyButton: boolean
  siteId: string
  tableToken?: null | string
}) => {
  const [definitions, productResult] = await Promise.all([
    findForSite('taxonomy-definitions', siteId, {
      depth: 0, limit: 1, locale, where: { key: { equals: CAFE_MENU_TAXONOMY } },
    }),
    findForSite('products', siteId, {
      depth: 1, limit: 1000, locale, pagination: false,
      where: { and: [{ menuSourceSystem: { equals: 'biza_miz' } }, { _status: { equals: 'published' } }] },
    }),
  ])
  const taxonomy = definitions.docs[0]
  const terms = taxonomy
    ? (await findForSite('taxonomy-terms', siteId, {
        depth: 0, limit: 1000, locale, pagination: false,
        where: { taxonomy: { equals: taxonomy.id } },
      })).docs
    : []
  const categories: CafeMenuCategory[] = menuSort(terms.map((term) => ({
    id: String(term.id), name: term.name, description: term.description,
    menuOrder: term.menuOrder, sourceId: term.menuSourceId,
  })))
  const categoryIds = new Set(categories.map(({ id }) => id))
  const products: CafeMenuItem[] = menuSort(productResult.docs.map((product) => ({
    id: String(product.id), sourceId: product.menuSourceId, title: product.title,
    summary: product.summary, price: product.price, menuOrder: product.menuOrder,
    menuAvailability: product.menuAvailability, trackInventory: product.trackInventory,
    inventory: product.inventory, productType: product.productType,
    categoryIds: (product.terms ?? []).flatMap((term) => {
      const id = idOf(term)
      return id && categoryIds.has(id) ? [id] : []
    }),
    modifierGroups: product.modifierGroups ?? [],
    variations: (product.variations ?? []).flatMap((variation) =>
      variation.active !== false && variation.key
        ? [{ key: variation.key, label: variation.label || variation.key, price: variation.price, trackInventory: variation.trackInventory, inventory: variation.inventory }]
        : [],
    ),
    image: product.image ? <Media resource={product.image} className="h-full w-full" imgClassName="h-full w-full object-cover" size="33vw" /> : null,
  })))
  if (!products.length) return null
  return <CafeMenuClient categories={categories} currency={currency} heading={heading} intro={intro} locale={locale} paymentMethods={paymentMethods} products={products} showBuyButton={showBuyButton} tableToken={isTableToken(tableToken) ? tableToken : null} />
}
