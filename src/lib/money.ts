/**
 * Money, in the currency a site actually sells in.
 *
 * ## Toman or Rial — decided, once, here (issue #8)
 *
 * The official currency of Iran is the **Rial**; every price a human quotes is in
 * **Toman** (۱ تومان = ۱۰ ریال). Storing one and labelling the other is an
 * off-by-10× error on every figure on the site, and no amount of care at the
 * keyboard prevents it — the number looks right either way.
 *
 * So the platform's answer is not "convert correctly", it is "there is only ever
 * one unit to be wrong about":
 *
 * - Prices are stored as an **integer count of the currency's minor unit**
 *   (`120000` = ۱۲۰٬۰۰۰ تومان for an Iranian site, `120000` = $1,200.00 for a USD
 *   one). Never a float, never a Rial amount, never the display string.
 * - The unit a site sells in is a field on its `store` document, and *only* the
 *   number is stored on the product — the unit name comes from the site, so an
 *   editor cannot type a price in one unit and label it in another.
 * - Every read of a stored price goes through `formatPrice()` (render) or
 *   `parsePrice()` (input). Those are inverse by construction, and there is a test
 *   that says so.
 *
 * ## Why not `Intl`'s `style: 'currency'`?
 *
 * `IRT` — the code this platform uses for Toman — is not an ISO 4217 code, so
 * `Intl` renders it as the bare letters `IRT` rather than a word, and Persian
 * prices want `۱٬۲۰۰٬۰۰۰ تومان`: Persian-Indic digits, the Persian thousands
 * separator, and the unit as a word *after* the number. That is `formatNumber()`
 * (which every number on the platform goes through) plus a unit label, so that is
 * what this module builds. The unit name is per-locale, which is also why it is
 * data here and not a `currency` option.
 */

import { toAsciiDigits } from './digits'

export type CurrencyCode = 'IRT' | 'IRR' | 'USD' | 'EUR'

export type Currency = {
  code: CurrencyCode
  /**
   * How many minor units make one major unit — the exponent, not the number of
   * digits shown. Toman and Rial are accounted in whole units (0); dollar and euro
   * in cents (2). It decides only where the decimal point sits.
   */
  minorDigits: 0 | 2
  /**
   * The word rendered after the amount, per locale. `fa` is the base locale, so a
   * missing key would show the site's prices unit-less — required by the type.
   */
  unit: { en: string; fa: string }
}

/**
 * The registry. Adding a currency here is the whole of "support a new currency":
 * it becomes selectable on a site's `store` document and every price on that site
 * renders and parses in it.
 *
 * `IRR` exists so a customer who insists on Rial *can* have it — but the platform
 * default, and the recommendation in the admin copy, is `IRT`.
 */
export const currencies: Record<CurrencyCode, Currency> = {
  EUR: { code: 'EUR', minorDigits: 2, unit: { en: '€', fa: 'یورو' } },
  IRR: { code: 'IRR', minorDigits: 0, unit: { en: 'IRR', fa: 'ریال' } },
  IRT: { code: 'IRT', minorDigits: 0, unit: { en: 'Toman', fa: 'تومان' } },
  USD: { code: 'USD', minorDigits: 2, unit: { en: '$', fa: 'دلار' } },
}

export const currencyCodes = Object.keys(currencies) as CurrencyCode[]

export const isCurrencyCode = (value: unknown): value is CurrencyCode =>
  typeof value === 'string' && (currencyCodes as string[]).includes(value)

/** `۱ تومان = ۱۰ ریال`, in minor units — the only conversion the platform does. */
export const tomanToRial = (tomanMinor: number): number => tomanMinor * 10

export const rialToToman = (rialMinor: number): number => {
  // A Rial figure that is not a whole Toman is a data-entry mistake, and rounding
  // it silently would hide the 10× error this module exists to prevent.
  if (rialMinor % 10 !== 0) {
    throw new RangeError('قیمت ریالی باید مضرب ۱۰ باشد (هر تومان ۱۰ ریال است).')
  }

  return rialMinor / 10
}

/** Minor units of `code` for a whole number of major units — `12` → `1200` for USD. */
export const majorToMinor = (major: number, code: CurrencyCode): number => {
  const { minorDigits } = currencies[code]

  return Math.round(major * 10 ** minorDigits)
}

export const minorToMajor = (minor: number, code: CurrencyCode): number =>
  minor / 10 ** currencies[code].minorDigits

const HAS_DIGITS = /[۰-۹٠-٩0-9]/

/**
 * Any amount a human typed — Persian or Latin digits, with or without thousands
 * separators, with or without the unit word — into integer minor units.
 *
 * `null` means "not a number we can store": the admin and the checkout form both
 * surface that as a validation message rather than guessing. Fractional Toman is
 * rejected outright (there is no smaller coin), while `12.5` USD is 1250 cents and
 * accepted.
 */
export const parsePrice = (input: number | string, code: CurrencyCode): null | number => {
  const text =
    typeof input === 'number'
      ? String(input)
      : typeof input === 'string'
        ? input
        : undefined

  if (text === undefined || !HAS_DIGITS.test(text)) return null

  const normalized = toAsciiDigits(text)
    // The decimal point is ٫ in Persian typography and . in Latin; both mean the
    // same thing and both have to survive, or `۱۲٫۵` reads as `۱۲۵`.
    .replace(/\u066b/g, '.')
    // The thousands separator is ٬ in Persian output and , in Latin; a thin or
    // non-breaking space is what a price copied out of a PDF tends to carry.
    .replace(/[٬،\s\u00a0\u202f]/g, '')
    .replace(/[^0-9.]/g, '')

  // One decimal point, nothing else. `Number('1.2.3')` is NaN, so a single check
  // on the shape is enough to keep the parse honest.
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null

  const minor = Number(normalized) * 10 ** currencies[code].minorDigits

  // No rounding: `۱۲٫۵ تومان` has no such coin, and `$12.345` would be a fraction
  // of a cent. Silently rounding either is how a price stops matching the money.
  return Number.isInteger(minor) ? minor : null
}

/** Field-validation shape: `true` or a Persian message, for a `number` price field. */
export const validatePriceMinor = (value: unknown): string | true => {
  if (value === null || value === undefined || value === '') return true
  const n = Number(value)

  return Number.isInteger(n) && n >= 0
    ? true
    : 'قیمت باید عدد صحیح و غیرمنفی باشد (بر حسب واحد پول سایت، نه ریال).'
}
