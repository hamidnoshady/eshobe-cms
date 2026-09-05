import type { TypedLocale } from 'payload'

import type { PaymentProviderName } from '@/payments'
import type { PaymentMethodOption } from './checkout'

import type { CurrencyCode } from './money'

import configPromise from '@payload-config'
import { createLocalReq, getPayload } from 'payload'

import { listEnabledGateways } from '@/payments/gateways'

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

/**
 * The gateways a server component should offer on this site, in the order to offer them.
 *
 * Sits beside `storeSettingsForSite` rather than inside it because the checkout endpoint
 * needs the settings and *not* this list (it resolves the buyer's own choice against the
 * amount they actually committed to), and folding an extra query into a function both call
 * would make every checkout pay for a list it discards.
 *
 * Builds a local `PayloadRequest` because `listEnabledGateways` needs one and a server
 * component has none: every credential read hangs its internal secret flag off
 * `req.context`. It lives here rather than in `src/payments/gateways/resolve.ts` so that
 * module never imports `@payload-config` — a module that decrypts merchant credentials and
 * decides who may pay should not also be the one that boots the whole CMS, and keeping it
 * out means the gateway registry can be unit-tested without a database or an `.env`.
 *
 * `amount` is optional for the same reason it is on `listEnabledGateways`: a product card
 * does not know the quantity yet, so it shows every enabled gateway and the endpoint
 * re-checks the window when the buyer commits.
 */
export const paymentMethodsForSite = async (
  siteId: string,
  {
    amount,
    currency,
    locale,
  }: { amount?: null | number; currency: CurrencyCode; locale?: TypedLocale },
): Promise<PaymentMethodOption[]> => {
  const payload = await getPayload({ config: configPromise })
  const req = await createLocalReq({ ...(locale ? { locale } : {}) }, payload)

  return (await listEnabledGateways({
    ...(amount === null || amount === undefined ? {} : { amount }),
    currency,
    ...(locale ? { locale } : {}),
    req,
    siteId,
  })) as PaymentMethodOption[]
}
