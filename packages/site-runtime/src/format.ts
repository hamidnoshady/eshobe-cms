/**
 * The only place dates and numbers are formatted.
 *
 * Persian pages get Shamsi (Jalali) dates and Persian-Indic digits; every other
 * locale gets its own calendar and digits from the same call site. Nothing else
 * may call `Intl` directly, use `toLocaleDateString()`, or interpolate a raw
 * `Date` — see CLAUDE.md.
 */

import type { CurrencyCode } from './money'

import { currencies, minorToMajor } from './money'

// Payload locale codes are short forms; Intl wants a BCP 47 tag.
const intlLocale = (locale: string) => (locale === 'fa' ? 'fa-IR' : locale)

// ponytail: one platform timezone, so a UTC timestamp near midnight doesn't
// render as the previous day. Becomes a `timezone` field on `sites` if we ever
// host a customer outside Iran.
const PLATFORM_TIME_ZONE = 'Asia/Tehran'

export const formatDate = (
  date: Date | string | number | null | undefined,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'long' },
): string => {
  if (date === null || date === undefined || date === '') return ''

  return new Intl.DateTimeFormat(intlLocale(locale), {
    // 'persian' *is* the Jalali calendar — Intl ships it, so no date library.
    calendar: locale === 'fa' ? 'persian' : undefined,
    timeZone: PLATFORM_TIME_ZONE,
    ...options,
  }).format(new Date(date))
}

export const formatNumber = (
  value: number,
  locale: string,
  options?: Intl.NumberFormatOptions,
): string => new Intl.NumberFormat(intlLocale(locale), options).format(value)

/**
 * Digit substitution for strings that only look numeric — phone numbers, postal
 * codes, anything with a leading zero that `formatNumber` would eat.
 *
 * Re-exported from `src/lib/digits.ts` so money parsing can share the mapping without
 * importing this module; the rule that every rendered number goes through here stands.
 */
export { toLocaleDigits } from './digits'

/**
 * A price, in the site's currency, in the active locale's digits.
 *
 * `minor` is the stored integer — see `src/lib/money.ts` for why prices are minor
 * units of the *site's* currency and not of the product. The unit word is appended
 * from the currency registry, because a bare number on an Iranian storefront is
 * ambiguous by a factor of ten.
 *
 * Renders `۱٬۲۰۰٬۰۰۰ تومان` on `fa` and `1,200,000 Toman` on `en` for the same
 * stored value.
 */
export const formatPrice = (
  minor: null | number | undefined,
  code: CurrencyCode,
  locale: string,
  options: { hideUnit?: boolean } = {},
): string => {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return ''

  const currency = currencies[code]
  const amount = formatNumber(minorToMajor(minor, code), locale, {
    maximumFractionDigits: currency.minorDigits,
    minimumFractionDigits: currency.minorDigits,
  })

  if (options.hideUnit) return amount

  const unit = currency.unit[locale as 'en' | 'fa'] ?? currency.unit.en

  return `${amount} ${unit}`
}
