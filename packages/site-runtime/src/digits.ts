/**
 * Digit mapping between scripts — the primitive under `formatNumber` (render) and
 * `parsePrice` (input).
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/**
 * Digit substitution for strings that only look numeric — phone numbers, postal
 * codes, anything with a leading zero that `formatNumber` would eat.
 */
export const toLocaleDigits = (value: string, locale: string): string =>
  locale === 'fa' ? toAsciiDigits(value).replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]!) : value

/**
 * Persian-Indic and Arabic-Indic digits → ASCII, for anything typed *into* the
 * platform.
 */
export const toAsciiDigits = (value: string): string =>
  value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
