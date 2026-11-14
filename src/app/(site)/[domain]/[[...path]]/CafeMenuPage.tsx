import React from 'react'

import { notFound } from 'next/navigation'

import { CafeMenu } from '@/blocks/ProductGrid/CafeMenu'
import { getSiteContext } from '@/lib/site-context'
import { paymentMethodsForSite, storeSettingsForSite } from '@/lib/store'

import { queryPage } from './queries'
import { SitePage } from './SitePage'

/**
 * The public `/menu` alias used by Biza table QR links.
 *
 * Starter stores historically put their product page at `/products`, and that page
 * normally contains a catalog ProductGrid. The QR contract is deliberately not tied to
 * that editor-facing slug: `/menu` resolves the published `products` page and forces its
 * existing ProductGrid through the already-approved café projection. This keeps one page
 * and one design source instead of creating a second, drifting menu implementation.
 *
 * A site that has no starter page can still receive a Biza menu projection. In that case
 * the fallback renders the same `CafeMenu` server block directly; it remains scoped to
 * published `biza_miz` products and uses the site's own currency and payment settings.
 */
export const CafeMenuPage: React.FC<{ tableToken?: null | string }> = async ({ tableToken }) => {
  const { locale, serving, site } = await getSiteContext()

  if (!site || !serving) notFound()

  const productsPage = await queryPage('products')

  if (productsPage) {
    return <SitePage forceCafeMenu slug="products" tableToken={tableToken} />
  }

  const { currency } = await storeSettingsForSite(String(site.id), { cachePublic: true, locale })
  const paymentMethods = await paymentMethodsForSite(String(site.id), { currency, locale })

  return (
    <article className="pt-16 pb-24">
      <CafeMenu
        currency={currency}
        heading={site.name}
        intro={null}
        locale={locale}
        paymentMethods={paymentMethods}
        showBuyButton
        siteId={String(site.id)}
        tableToken={tableToken}
      />
    </article>
  )
}
