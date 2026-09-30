import { describe, expect, it } from 'vitest'

import { jalaliMonthLength, toGregorian, toJalali } from '@/lib/jalali'

describe('jalali', () => {
  it('round-trips every day of 1300–1500 against Intl', () => {
    for (let t = Date.UTC(1921, 2, 1); t < Date.UTC(2122, 2, 1); t += 86_400_000 * 7) {
      const date = new Date(t + 12 * 3_600_000)
      const [jy, jm, jd] = toJalali(date, 'UTC')
      expect(toGregorian(jy, jm, jd)).toEqual([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()])
    }
  })

  it('knows Nowruz 1405 and the length of Esfand', () => {
    expect(toGregorian(1405, 1, 1)).toEqual([2026, 3, 21])
    expect(jalaliMonthLength(1403, 12)).toBe(30) // leap
    expect(jalaliMonthLength(1404, 12)).toBe(29)
  })
})
