import { describe, expect, it } from 'vitest'

import { formatDate, formatNumber, toLocaleDigits } from '@/lib/format'

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
