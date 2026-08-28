import { describe, expect, it } from 'vitest'

import { formatDate, formatNumber, formatPrice, toLocaleDigits } from '@/lib/format'
import { parsePrice, rialToToman, tomanToRial, validatePriceMinor } from '@/lib/money'
import { DEFAULT_STORE_SETTINGS } from '@/lib/store'

const AUG_21_2026 = '2026-08-21T09:00:00.000Z'

describe('formatDate', () => {
  it('renders Shamsi with Persian digits on fa', () => {
    // 21 Aug 2026 Gregorian is in the year 1405 Shamsi
    expect(formatDate(AUG_21_2026, 'fa', { year: 'numeric' })).toBe('۱۴۰۵')
    expect(formatDate(AUG_21_2026, 'fa')).not.toMatch(/[0-9]/)
  })

  it('stays Gregorian with Latin digits on en', () => {
    expect(formatDate(AUG_21_2026, 'en', { year: 'numeric' })).toBe('2026')
  })

  it('resolves in Tehran time, not UTC', () => {
    // 21:00 UTC is already the next day in Tehran (+03:30)
    expect(formatDate('2026-08-21T21:00:00.000Z', 'en', { day: 'numeric' })).toBe('22')
  })

  it('returns empty for a missing date rather than throwing', () => {
    expect(formatDate(null, 'fa')).toBe('')
    expect(formatDate(undefined, 'fa')).toBe('')
    expect(formatDate('', 'fa')).toBe('')
  })
})

describe('formatNumber', () => {
  it('uses Persian-Indic digits on fa', () => {
    expect(formatNumber(1234, 'fa')).not.toMatch(/[0-9]/)
    expect(formatNumber(1234, 'fa')).toContain('۱')
  })

  it('leaves en in Latin digits', () => {
    expect(formatNumber(1234, 'en')).toBe('1,234')
  })
})

describe('toLocaleDigits', () => {
  it('keeps the leading zero that formatNumber would eat', () => {
    expect(toLocaleDigits('09121234567', 'fa')).toBe('۰۹۱۲۱۲۳۴۵۶۷')
    expect(formatNumber(9121234567, 'fa')).not.toContain('۰۹')
  })

  it('is a no-op on en', () => {
    expect(toLocaleDigits('09121234567', 'en')).toBe('09121234567')
  })
})

/**
 * Wave 7 §3.6 — prices. The Toman/Rial decision (issue #8) is encoded in
 * `src/lib/money.ts`; these are the tests that make it a rule rather than a comment.
 */
describe('formatPrice', () => {
  it('renders Persian-Indic digits and the unit as a word on fa', () => {
    expect(formatPrice(1_200_000, 'IRT', 'fa')).toBe('۱٬۲۰۰٬۰۰۰ تومان')
  })

  it('keeps Latin digits and the English unit on en', () => {
    expect(formatPrice(1_200_000, 'IRT', 'en')).toBe('1,200,000 Toman')
  })

  it('shows the two decimals a cent-based currency is accounted in', () => {
    expect(formatPrice(1250, 'USD', 'en')).toBe('12.50 $')
    expect(formatPrice(1250, 'USD', 'fa')).toBe('۱۲٫۵۰ دلار')
  })

  it('renders nothing, not zero, when there is no price', () => {
    expect(formatPrice(null, 'IRT', 'fa')).toBe('')
    expect(formatPrice(undefined, 'IRT', 'fa')).toBe('')
  })

  it('is the inverse of parsePrice', () => {
    for (const [minor, code] of [
      [480_000, 'IRT'],
      [198_000, 'IRT'],
      [1250, 'USD'],
    ] as [number, 'IRT' | 'USD'][]) {
      const rendered = formatPrice(minor, code, 'en', { hideUnit: true })

      expect(parsePrice(rendered, code)).toBe(minor)
    }
  })
})

describe('money', () => {
  it('accepts the digits a Persian keyboard actually types', () => {
    expect(parsePrice('۱٬۲۰۰٬۰۰۰', 'IRT')).toBe(1_200_000)
    expect(parsePrice('1,200,000', 'IRT')).toBe(1_200_000)
    expect(parsePrice('۱۲۰۰۰۰۰ تومان', 'IRT')).toBe(1_200_000)
    // Arabic-Indic, from an Arabic keyboard or a PDF.
    expect(parsePrice('١٢٣٤', 'IRT')).toBe(1234)
  })

  it('rejects what cannot be stored rather than rounding it', () => {
    expect(parsePrice('۱۲٫۵', 'IRT')).toBeNull() // half a toman is not a thing
    expect(parsePrice('12.345', 'USD')).toBeNull() // nor a tenth of a cent
    expect(parsePrice('۱۲', 'USD')).toBe(1200) // twelve dollars, in cents
    expect(parsePrice('free', 'IRT')).toBeNull()
    expect(parsePrice('', 'IRT')).toBeNull()
  })

  it('names the ten-times step, so nobody re-derives it', () => {
    expect(tomanToRial(120_000)).toBe(1_200_000)
    expect(rialToToman(1_200_000)).toBe(120_000)
    // A Rial figure that is not a whole Toman is the mistake itself, caught at the
    // only place the conversion is allowed to happen.
    expect(() => rialToToman(1_200_005)).toThrow(RangeError)
  })

  it('is the same amount in both Iranian units, which is the whole point', () => {
    const toman = 1_200_000

    expect(formatPrice(toman, 'IRT', 'fa')).toBe('۱٬۲۰۰٬۰۰۰ تومان')
    expect(formatPrice(tomanToRial(toman), 'IRR', 'fa')).toBe('۱۲٬۰۰۰٬۰۰۰ ریال')
  })

  it('defaults a store with no settings document to Toman, not Rial', () => {
    expect(DEFAULT_STORE_SETTINGS.currency).toBe('IRT')
  })

  it('refuses a price that is negative or fractional at the field, too', () => {
    expect(validatePriceMinor(-1)).not.toBe(true)
    expect(validatePriceMinor(12.5)).not.toBe(true)
    expect(validatePriceMinor(12)).toBe(true)
    // Empty is the field's own `required` to complain about, not this validator.
    expect(validatePriceMinor(null)).toBe(true)
  })
})
