'use client'

import type { FieldDescriptionClientProps } from 'payload'

import { useField, useLocale } from '@payloadcms/ui'
import React from 'react'

import { formatDate } from '@/lib/format'

/**
 * Shows a Gregorian date field's value in Shamsi, under the picker.
 *
 * Payload's date picker is react-datepicker and Gregorian only; replacing it means
 * a custom field component wrapping a Persian calendar, which is a real widget —
 * keyboard handling, month arithmetic, the ZWNJ in month names — for two fields
 * (`pages.publishedAt`, `posts.publishedAt`) that are *auto-filled on publish* and
 * only touched to back-date something.
 *
 * So: keep the native picker, echo the value in the calendar the editor thinks in.
 * They pick 2026-03-21 and immediately read «۱ فروردین ۱۴۰۵» — enough to catch an
 * off-by-a-year without a single line of calendar code. This is the Wave 3 decision
 * the plan asked for (§3.6); a true Jalali picker stays unbuilt until an editor
 * actually asks for one.
 *
 * ponytail: display only — the stored value is still the Gregorian ISO string the
 * picker wrote, so nothing downstream changes.
 */
export const ShamsiDateHint: React.FC<FieldDescriptionClientProps> = ({ path }) => {
  const { value } = useField<string>({ path })
  const { code } = useLocale()

  // Only where it helps: on `en` the picker already shows the calendar in use.
  if (code !== 'fa' || !value) return null

  return (
    // `field-description` for Payload's own styling; `shamsi-date-hint` so anything
    // looking for this hint has a name to ask for. Payload renders a field's
    // Description as a *sibling* of `#field-<path>`, not a child, so a selector built
    // from the field id finds the picker and never the hint.
    <div className="field-description shamsi-date-hint">
      {/* `dateStyle: 'full'` includes the weekday — the other half of a back-dating
          mistake, and free from the same Intl call. */}
      {formatDate(value, 'fa', { dateStyle: 'full' })}
    </div>
  )
}
