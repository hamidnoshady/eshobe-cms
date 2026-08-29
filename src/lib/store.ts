import type { TypedLocale } from 'payload'

import type { PaymentProviderName } from '@/payments'

import type { CurrencyCode } from './money'

import { findGlobalForSite } from './site-query'

/**
 * What the storefront needs to know about a site's commerce settings.
 *
 * A `store` document only exists once somebody saves one, so both fields have a
 * default that works on a brand-new store site — otherwise "add a store" would mean
 * "and also fill in this one form, or the catalogue renders no prices at all".
 */
export type StoreSettings = {
  currency: CurrencyCode
  paymentProvider: PaymentProviderName
}

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  currency: 'IRT',
  paymentProvider: 'bank',
}

/**
 * The public half of a site's store settings, read through `findGlobalForSite` so it
 * is scoped to one tenant.
 *
 * `paymentInstructions` is not part of this on purpose: the field is access-locked to
 * staff, and the only reader allowed to see it for one buyer is
 * `src/lib/order-receipt.ts`.
 */
export const storeSettingsForSite = async (
  siteId: string,
  { locale }: { locale?: TypedLocale },
): Promise<StoreSettings> => {
  const doc = await findGlobalForSite('store', siteId, { depth: 0, locale })

  return {
    currency: doc?.currency ?? DEFAULT_STORE_SETTINGS.currency,
    paymentProvider: doc?.paymentProvider ?? DEFAULT_STORE_SETTINGS.paymentProvider,
  }
}
