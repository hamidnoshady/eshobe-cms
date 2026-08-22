/**
 * The only place dates and numbers are formatted.
 *
 * Persian pages get Shamsi (Jalali) dates and Persian-Indic digits; every other
 * locale gets its own calendar and digits from the same call site. Nothing else
 * may call `Intl` directly, use `toLocaleDateString()`, or interpolate a raw
 * `Date` — see CLAUDE.md.
 */

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

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/**
 * Digit substitution for strings that only look numeric — phone numbers, postal
 * codes, anything with a leading zero that `formatNumber` would eat.
 */
export const toLocaleDigits = (value: string, locale: string): string =>
  locale === 'fa' ? value.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]!) : value
