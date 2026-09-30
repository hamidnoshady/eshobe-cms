'use client'

import type { DateFieldClientProps } from 'payload'

import { DateTimeField, FieldLabel, useField, useTranslation } from '@payloadcms/ui'
import React from 'react'

import { formatNumber } from '@/lib/format'
import { jalaliMonthLength, toGregorian, toJalali } from '@/lib/jalali'

const MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
]

// Same zone `formatDate()` renders in, so the picker and the published page agree on the day.
// ponytail: fixed +03:30 (Iran has had no DST since 2022); dates before that shift by an hour.
const ZONE = 'Asia/Tehran'
const OFFSET_MS = 3.5 * 3_600_000

const digits = (n: number, pad = 1) =>
  formatNumber(n, 'fa', { minimumIntegerDigits: pad, useGrouping: false })

/**
 * Jalali replacement for Payload's Gregorian date picker, used when the admin runs in
 * Persian; in English it renders Payload's own field untouched. The stored value is still
 * the ISO string Payload expects — only the widget speaks Shamsi.
 */
export const JalaliDateField: React.FC<DateFieldClientProps> = (props) => {
  const { i18n } = useTranslation()
  if (i18n.language !== 'fa') return <DateTimeField {...props} />
  return <Jalali {...props} />
}

const Jalali: React.FC<DateFieldClientProps> = ({ field, path, readOnly }) => {
  const { setValue, showError, value } = useField<string>({ potentiallyStalePath: path })
  const withTime = (field.admin?.date as { pickerAppearance?: string } | undefined)?.pickerAppearance === 'dayAndTime'

  const instant = value ? new Date(value) : null
  const shifted = instant ? new Date(instant.getTime() + OFFSET_MS) : null
  const [jy, jm, jd] = instant ? toJalali(instant, ZONE) : [0, 0, 0]
  const hour = shifted?.getUTCHours() ?? 0
  const minute = shifted?.getUTCMinutes() ?? 0

  const thisYear = toJalali(new Date(), ZONE)[0]
  const first = Math.min(thisYear - 30, jy || thisYear)
  const last = Math.max(thisYear + 10, jy || thisYear)
  const years = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const days = Array.from({ length: jy ? jalaliMonthLength(jy, jm) : 31 }, (_, i) => i + 1)

  // A half-filled date (only the month picked) starts from today, so every pick yields a real value.
  const set = (patch: Partial<Record<'y' | 'm' | 'd' | 'h' | 'min', number>>) => {
    const [ty, tm, td] = instant ? [jy, jm, jd] : toJalali(new Date(), ZONE)
    const y = patch.y ?? ty
    const m = patch.m ?? tm
    const d = Math.min(patch.d ?? td, jalaliMonthLength(y, m))
    const [gy, gm, gd] = toGregorian(y, m, d)
    const h = patch.h ?? hour
    const min = patch.min ?? minute
    setValue(new Date(Date.UTC(gy, gm - 1, gd, h, min) - OFFSET_MS).toISOString())
  }

  const num = (key: 'y' | 'm' | 'd' | 'h' | 'min') => (e: React.ChangeEvent<HTMLSelectElement>) =>
    set({ [key]: Number(e.target.value) })
  const cell: React.CSSProperties = { flex: '1 1 0', minWidth: 0 }

  return (
    <div className={`field-type date-time-field jalali-date-field${showError ? ' error' : ''}`}>
      <FieldLabel label={field.label} path={path} required={field.required} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} dir="rtl">
        <select aria-label="روز" disabled={readOnly} onChange={num('d')} style={cell} value={jd || ''}>
          {!jd && <option value="">روز</option>}
          {days.map((d) => (
            <option key={d} value={d}>{digits(d)}</option>
          ))}
        </select>
        <select aria-label="ماه" disabled={readOnly} onChange={num('m')} style={cell} value={jm || ''}>
          {!jm && <option value="">ماه</option>}
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>{name}</option>
          ))}
        </select>
        <select aria-label="سال" disabled={readOnly} onChange={num('y')} style={cell} value={jy || ''}>
          {!jy && <option value="">سال</option>}
          {years.map((y) => (
            <option key={y} value={y}>{digits(y)}</option>
          ))}
        </select>
        {withTime && (
          <>
            <select aria-label="ساعت" disabled={readOnly} onChange={num('h')} style={cell} value={hour}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{digits(h, 2)}</option>
              ))}
            </select>
            <select aria-label="دقیقه" disabled={readOnly} onChange={num('min')} style={cell} value={minute}>
              {Array.from({ length: 60 }, (_, m) => (
                <option key={m} value={m}>{digits(m, 2)}</option>
              ))}
            </select>
          </>
        )}
        {!field.required && value ? (
          <button
            className="btn btn--style-secondary btn--size-small"
            disabled={readOnly}
            onClick={() => setValue(null)}
            type="button"
          >
            پاک کردن
          </button>
        ) : null}
      </div>
    </div>
  )
}
