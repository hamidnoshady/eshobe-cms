/**
 * Jalali <-> Gregorian arithmetic for the admin date picker, on top of `Intl`'s
 * `persian` calendar — no date library (CLAUDE.md), and no hand-rolled leap rule
 * that could drift from what `formatDate()` prints.
 */

const DAY = 864e5

// ponytail: fixed +03:30 — Iran dropped DST in 2022, and `formatDate()` pins Asia/Tehran
// too. Becomes a per-site zone if we ever host a customer elsewhere.
const TEHRAN_OFFSET = 210 * 60e3

// Not rendered: Latin digits are the point, these parts feed arithmetic, not the UI.
// eslint-disable-next-line no-restricted-syntax
const parts = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  day: 'numeric',
  month: 'numeric',
  timeZone: 'UTC',
  year: 'numeric',
})

export type JDate = { d: number; m: number; y: number }

/** Jalali y/m/d of a Gregorian instant, read in UTC. */
export const jParts = (date: Date): JDate => {
  const p = Object.fromEntries(parts.formatToParts(date).map((x) => [x.type, x.value]))
  return { d: Number(p.day), m: Number(p.month), y: Number(p.year) }
}

const key = ({ d, m, y }: JDate) => y * 10000 + m * 100 + d

/** The UTC-noon Date whose Jalali date is y/m/d. Intl is the source of truth; we only search. */
export const jToDate = (y: number, m: number, d: number): Date => {
  let t = Date.UTC(y + 621, 2, 21, 12) + ((m - 1) * 30.5 + d - 1) * DAY
  const want = key({ d, m, y })
  // Coarse jumps, then single days — converges in a handful of steps.
  for (let i = 0; i < 60; i++) {
    const p = jParts(new Date(t))
    const got = key(p)
    if (got === want) break
    const days = (y - p.y) * 365 + (m - p.m) * 30 + (d - p.d)
    t += (Math.abs(days) > 3 ? days : got < want ? 1 : -1) * DAY
  }
  return new Date(t)
}

export const jMonthLength = (y: number, m: number): number => {
  const next = m === 12 ? jToDate(y + 1, 1, 1) : jToDate(y, m + 1, 1)
  return Math.round((+next - +jToDate(y, m, 1)) / DAY)
}

/** 0 = Saturday … 6 = Friday, the Persian week. */
export const jWeekday = (y: number, m: number, d: number): number =>
  (jToDate(y, m, d).getUTCDay() + 1) % 7

/** A stored instant as Tehran wall-clock fields (h/min via UTC getters of the shifted date). */
export const toWall = (iso: Date | string) => {
  const w = new Date(new Date(iso).getTime() + TEHRAN_OFFSET)
  return { ...jParts(w), h: w.getUTCHours(), min: w.getUTCMinutes() }
}

/** Tehran wall-clock Jalali fields back to the ISO string Payload stores. */
export const fromWall = (y: number, m: number, d: number, h = 12, min = 0): string => {
  const g = jToDate(y, m, d)
  return new Date(
    Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate(), h, min) - TEHRAN_OFFSET,
  ).toISOString()
}
