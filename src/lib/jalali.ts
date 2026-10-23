/**
 * Jalali ⇄ Gregorian calendar-date arithmetic for the admin's date field. Display of a
 * date stays on `formatDate()`; this exists only because a picker has to *write* a date,
 * and `Intl` cannot parse one back.
 */

/** Gregorian → Jalali, via `Intl` (`calendar: 'persian'`) so it agrees with `formatDate`. */

// Cache Intl formatters to avoid the high overhead of instantiating them on every function call.
const jalaliFormatCache = new Map<string, Intl.DateTimeFormat>()

export function toJalali(date: Date, timeZone: string): [number, number, number] {
  // Parsing, not display: Latin digits and a fixed calendar are the point, so `formatDate` cannot do this.
  let formatter = jalaliFormatCache.get(timeZone)
  if (!formatter) {
    // eslint-disable-next-line no-restricted-syntax
    formatter = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
      day: 'numeric',
      month: 'numeric',
      timeZone,
      year: 'numeric',
    })
    jalaliFormatCache.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return [get('year'), get('month'), get('day')]
}

/** Jalali → Gregorian (`[year, month 1–12, day]`). Standard 33-year-cycle algorithm. */
export function toGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  const y = jy + 1595
  let days = -355668 + 365 * y + Math.floor(y / 33) * 8 + Math.floor(((y % 33) + 3) / 4) + jd
  days += jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186
  let gy = 400 * Math.floor(days / 146097)
  days %= 146097
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524)
    days %= 36524
    if (days >= 365) days++
  }
  gy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    gy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  let gd = days + 1
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let gm = 0
  while (gm < 12 && gd > months[gm]!) gd -= months[gm++]!
  return [gy, gm + 1, gd]
}

/** Days in a Jalali month: 31 for the first six, 30 for the next five, Esfand 29 or 30. */
export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm < 7) return 31
  if (jm < 12) return 30
  // Esfand has 30 days exactly when the next Farvardin 1 falls 366 days after this one's.
  const [a, b, c] = toGregorian(jy, 1, 1)
  const [d, e, f] = toGregorian(jy + 1, 1, 1)
  return Math.round((Date.UTC(d, e - 1, f) - Date.UTC(a, b - 1, c)) / 86_400_000) === 366 ? 30 : 29
}
