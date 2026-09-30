'use client'

import type { DateFieldClientProps } from 'payload'

import { DateTimeField, FieldDescription, FieldError, FieldLabel, useField, useTranslation } from '@payloadcms/ui'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { formatDate, formatNumber } from '@/lib/format'
import { jalaliMonthLength as jMonthLength, toGregorian, toJalali } from '@/lib/jalali'

const WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج']
const YEAR_PAGE = 12

const num = (n: number) => formatNumber(n, 'fa', { useGrouping: false })
const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']
const monthName = (m: number) => MONTHS[m - 1]

// Same zone `formatDate()` renders in, so the picker and the published page agree on the day.
// ponytail: fixed +03:30 (Iran has had no DST since 2022).
const ZONE = 'Asia/Tehran'
const OFFSET = 210 * 60e3

/** A stored instant as Tehran wall-clock Jalali fields. */
const toWall = (iso: Date | string) => {
  const t = new Date(iso)
  const [y, m, d] = toJalali(t, ZONE)
  const w = new Date(+t + OFFSET)
  return { d, h: w.getUTCHours(), m, min: w.getUTCMinutes(), y }
}

/** Tehran wall-clock Jalali fields back to the ISO string Payload stores. */
const fromWall = (y: number, m: number, d: number, h = 12, min = 0): string => {
  const [gy, gm, gd] = toGregorian(y, m, d)
  return new Date(Date.UTC(gy, gm - 1, gd, h, min) - OFFSET).toISOString()
}

/** 0 = Saturday … 6 = Friday, the Persian week. */
const jWeekday = (y: number, m: number, d: number): number => {
  const [gy, gm, gd] = toGregorian(y, m, d)
  return (new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay() + 1) % 7
}

const Chevron: React.FC = () => (
  <svg aria-hidden height="14" viewBox="0 0 24 24" width="14">
    <path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
)

/**
 * Payload's date field for Persian admins: a Jalali calendar popover (days → months →
 * years, like a modern picker) that still stores the same Gregorian ISO string the stock
 * field does, so nothing downstream changes. English admins and month/time-only fields
 * get Payload's own react-datepicker untouched — see `JalaliDateField` below.
 */
const JalaliPicker: React.FC<DateFieldClientProps> = (props) => {
  const {
    field: { admin: { className, date, description } = {}, label, localized, required },
    path,
    readOnly,
    validate,
  } = props
  const withTime = (date as { pickerAppearance?: string } | undefined)?.pickerAppearance === 'dayAndTime'

  const memoValidate = useCallback(
    (value: unknown, options: object) =>
      typeof validate === 'function' ? validate(value as never, { ...options, required } as never) : true,
    [validate, required],
  )
  const { disabled, setValue, showError, value } = useField<string>({
    potentiallyStalePath: path,
    validate: memoValidate as never,
  })
  const locked = Boolean(readOnly || disabled)

  const selected = value ? toWall(value) : null
  const today = toWall(new Date())
  const start = selected ?? today

  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'days' | 'months' | 'years'>('days')
  const [cursor, setCursor] = useState({ m: start.m, y: start.y })
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const toggle = () => {
    if (locked) return
    setCursor({ m: start.m, y: start.y })
    setView('days')
    setOpen((o) => !o)
  }

  const pick = (d: number) => {
    setValue(fromWall(cursor.y, cursor.m, d, withTime ? (selected?.h ?? 0) : 12, withTime ? (selected?.min ?? 0) : 0))
    if (!withTime) setOpen(false)
  }

  const setTime = (h: number, min: number) => {
    const base = selected ?? today
    setValue(fromWall(base.y, base.m, base.d, h, min))
  }

  const step = (dir: 1 | -1) => {
    if (view === 'days') {
      const m = cursor.m + dir
      setCursor(m < 1 ? { m: 12, y: cursor.y - 1 } : m > 12 ? { m: 1, y: cursor.y + 1 } : { m, y: cursor.y })
    } else setCursor({ ...cursor, y: cursor.y + dir * (view === 'years' ? YEAR_PAGE : 1) })
  }

  const yearFrom = cursor.y - (cursor.y % YEAR_PAGE)
  const title =
    view === 'days' ? `${monthName(cursor.m)} ${num(cursor.y)}` : view === 'months' ? num(cursor.y) : `${num(yearFrom)}–${num(yearFrom + YEAR_PAGE - 1)}`

  const lead = jWeekday(cursor.y, cursor.m, 1)
  const cells: (null | number)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: jMonthLength(cursor.y, cursor.m) }, (_, i) => i + 1),
  ]

  return (
    <div
      className={['field-type', 'date-time-field', 'jdp', className, showError && 'date-time-field--has-error'].filter(Boolean).join(' ')}
      ref={root}
    >
      <FieldLabel label={label} localized={localized} path={path} required={required} />
      <div className="field-type__wrap" id={`field-${path.replace(/\./g, '__')}`}>
        <FieldError path={path} showError={showError} />
        <div className="jdp__control">
          <button className="jdp__input" disabled={locked} onClick={toggle} type="button">
            {value ? formatDate(value, 'fa', withTime ? { dateStyle: 'long', timeStyle: 'short' } : { dateStyle: 'long' }) : <span className="jdp__placeholder">انتخاب تاریخ</span>}
          </button>
          {value && !locked && !required && (
            <button aria-label="پاک کردن" className="jdp__clear" onClick={() => setValue(null)} type="button">
              ×
            </button>
          )}
        </div>

        {open && (
          <div className="jdp__popover" role="dialog">
            <div className="jdp__head">
              <button aria-label="قبلی" className="jdp__nav jdp__nav--prev" onClick={() => step(-1)} type="button">
                <Chevron />
              </button>
              <button
                className="jdp__title"
                onClick={() => setView(view === 'days' ? 'months' : view === 'months' ? 'years' : 'days')}
                type="button"
              >
                {title}
              </button>
              <button aria-label="بعدی" className="jdp__nav jdp__nav--next" onClick={() => step(1)} type="button">
                <Chevron />
              </button>
            </div>

            {view === 'days' && (
              <div className="jdp__grid jdp__grid--days">
                {WEEKDAYS.map((w) => (
                  <span className="jdp__weekday" key={w}>{w}</span>
                ))}
                {cells.map((d, i) =>
                  d === null ? (
                    <span key={`e${i}`} />
                  ) : (
                    <button
                      className={[
                        'jdp__cell',
                        selected && selected.y === cursor.y && selected.m === cursor.m && selected.d === d && 'is-selected',
                        today.y === cursor.y && today.m === cursor.m && today.d === d && 'is-today',
                      ].filter(Boolean).join(' ')}
                      key={d}
                      onClick={() => pick(d)}
                      type="button"
                    >
                      {num(d)}
                    </button>
                  ),
                )}
              </div>
            )}

            {view === 'months' && (
              <div className="jdp__grid jdp__grid--pick">
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <button
                    className={['jdp__cell', selected && selected.y === cursor.y && selected.m === m && 'is-selected'].filter(Boolean).join(' ')}
                    key={m}
                    onClick={() => { setCursor({ ...cursor, m }); setView('days') }}
                    type="button"
                  >
                    {monthName(m)}
                  </button>
                ))}
              </div>
            )}

            {view === 'years' && (
              <div className="jdp__grid jdp__grid--pick">
                {Array.from({ length: YEAR_PAGE }, (_, i) => yearFrom + i).map((y) => (
                  <button
                    className={['jdp__cell', selected?.y === y && 'is-selected'].filter(Boolean).join(' ')}
                    key={y}
                    onClick={() => { setCursor({ ...cursor, y }); setView('months') }}
                    type="button"
                  >
                    {num(y)}
                  </button>
                ))}
              </div>
            )}

            {withTime && (
              <div className="jdp__time" dir="ltr">
                <input
                  aria-label="ساعت"
                  max={23}
                  min={0}
                  onChange={(e) => setTime(Math.min(23, Math.max(0, Number(e.target.value))), selected?.min ?? 0)}
                  type="number"
                  value={selected?.h ?? 0}
                />
                :
                <input
                  aria-label="دقیقه"
                  max={59}
                  min={0}
                  onChange={(e) => setTime(selected?.h ?? 0, Math.min(59, Math.max(0, Number(e.target.value))))}
                  type="number"
                  value={selected?.min ?? 0}
                />
              </div>
            )}
          </div>
        )}
      </div>
      <FieldDescription description={description} path={path} />
    </div>
  )
}

export const JalaliDateField: React.FC<DateFieldClientProps> = (props) => {
  const { i18n } = useTranslation()
  const appearance = (props.field.admin?.date as { pickerAppearance?: string } | undefined)?.pickerAppearance ?? 'default'
  const supported = ['default', 'dayOnly', 'dayAndTime'].includes(appearance)

  return i18n.language === 'fa' && supported ? <JalaliPicker {...props} /> : <DateTimeField {...props} />
}
