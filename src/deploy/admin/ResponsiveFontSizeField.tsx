'use client'

import React, { useMemo, useState } from 'react'

import type { ManifestRuntimeSetting } from '@/lib/deploy/manifest'
import { responsiveSpecOf } from '@/lib/deploy/manifest'
import {
  resolveResponsiveFontSize,
  TYPOGRAPHY_BREAKPOINTS,
  TYPOGRAPHY_DEVICE_WIDTHS,
  type ResponsiveDeviceValues,
  type ResponsiveFontSizeValue,
  type ResponsiveLayerResolution,
  type TypographyBreakpoint,
  type TypographyLocale,
} from '@/lib/deploy/theme-settings'
import { formatNumber } from '@/lib/format'

/**
 * One semantic typography role: a device selector, a px field per breakpoint, an
 * optional locale override and a live sample.
 *
 * ## Why the sample is driven by the resolver, not by the input
 *
 * The number in the box is the *explicit* value; an empty box means "inherit". The
 * sample renders `resolveResponsiveFontSize(...)`, the same function the save endpoint
 * and `GET /api/site` use, so the preview cannot disagree with the site about what
 * "inherited" resolves to. Nothing here writes to the server.
 *
 * ## Editing is local
 *
 * Device and locale switches only change component state, so moving between Mobile and
 * Desktop never discards a half-finished edit. The parent keeps the value and saves it
 * when the form is submitted.
 */

export type ResponsiveFontSizeFieldProps = {
  canEdit: boolean
  english: boolean
  onChange: (value: ResponsiveFontSizeValue | undefined) => void
  setting: ManifestRuntimeSetting
  siteLocales: string[]
  value: ResponsiveFontSizeValue | undefined
}

const DEVICE_LABELS: Record<TypographyBreakpoint, { en: string; fa: string }> = {
  desktop: { en: 'Desktop', fa: 'دسکتاپ' },
  mobile: { en: 'Mobile', fa: 'موبایل' },
  tablet: { en: 'Tablet', fa: 'تبلت' },
}

const LOCALE_LABELS: Record<string, { en: string; fa: string }> = {
  en: { en: 'English (LTR)', fa: 'انگلیسی (چپ‌به‌راست)' },
  fa: { en: 'Persian (RTL)', fa: 'فارسی (راست‌به‌چپ)' },
}

const SOURCE_LABELS: Record<
  'base' | 'custom' | 'inherited' | 'theme',
  { en: string; fa: string }
> = {
  base: { en: 'inherited from base', fa: 'ارث‌بری از مقدار پایه' },
  custom: { en: 'custom', fa: 'سفارشی' },
  inherited: { en: 'inherited', fa: 'ارث‌بری' },
  theme: { en: 'theme default', fa: 'پیش‌فرض پوسته' },
}

const clean = (value: ResponsiveFontSizeValue): ResponsiveFontSizeValue => {
  const next: ResponsiveFontSizeValue = {}
  for (const device of TYPOGRAPHY_BREAKPOINTS) {
    const candidate = value[device]
    if (typeof candidate === 'number') next[device] = candidate
  }
  const locales = Object.fromEntries(
    Object.entries(value.locales ?? {}).flatMap(([locale, devices]) => {
      const kept = Object.fromEntries(
        Object.entries(devices ?? {}).filter(([, px]) => typeof px === 'number'),
      ) as ResponsiveDeviceValues
      return Object.keys(kept).length ? [[locale, kept]] : []
    }),
  )
  if (Object.keys(locales).length) next.locales = locales
  /**
   * `{}` is a real value, not "no value": it means "use the theme default" and makes
   * the save explicit. Dropping the key instead would leave a preserved legacy value
   * in place, so a customer who cleared the field would keep seeing the old notice.
   */
  return next
}

const DeviceNumberInput: React.FC<{
  canEdit: boolean
  device: TypographyBreakpoint
  english: boolean
  explicit: number | undefined
  idPrefix: string
  label: string
  max: number
  min: number
  onCommit: (value: number | undefined) => void
  resolved: number
  step: number
}> = ({
  canEdit,
  device,
  english,
  explicit,
  idPrefix,
  label,
  max,
  min,
  onCommit,
  resolved,
  step,
}) => {
  const [draft, setDraft] = useState<null | string>(null)
  const [error, setError] = useState<null | string>(null)
  const inputId = `${idPrefix}-${device}`
  const errorId = `${inputId}-error`

  /**
   * The box shows the draft while it has focus and the parent's value otherwise. A
   * reset elsewhere therefore becomes visible without an effect that would fight the
   * keystroke the customer is in the middle of.
   */
  const shown = draft ?? (explicit === undefined ? '' : String(explicit))

  const commit = (raw: string) => {
    setDraft(raw)
    if (raw.trim() === '') {
      setError(null)
      onCommit(undefined)
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setError(english ? 'Enter a number.' : 'یک عدد وارد کنید.')
      return
    }
    if (parsed < min || parsed > max) {
      setError(
        english
          ? `Between ${min} and ${max} px.`
          : `باید بین ${formatNumber(min, 'fa')} و ${formatNumber(max, 'fa')} پیکسل باشد.`,
      )
      return
    }
    setError(null)
    onCommit(parsed)
  }

  return (
    <div className="theme-number">
      <label className="theme-number__label" htmlFor={inputId}>
        {label}
      </label>
      <div className={`theme-number__control${error ? ' theme-number__control--error' : ''}`}>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          disabled={!canEdit}
          id={inputId}
          inputMode="decimal"
          max={max}
          min={min}
          onBlur={() => setDraft(null)}
          onChange={(event) => commit(event.target.value)}
          step={step}
          type="number"
          value={shown}
        />
        <span aria-hidden="true" className="theme-number__unit">
          px
        </span>
      </div>
      <span className="theme-number__hint">
        {explicit === undefined
          ? english
            ? `Inherits ${resolved}px`
            : `ارث‌بری: ${formatNumber(resolved, 'fa')} پیکسل`
          : english
            ? `Custom · ${explicit}px`
            : `سفارشی · ${formatNumber(explicit, 'fa')} پیکسل`}
      </span>
      {error && (
        <span className="theme-number__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

export const ResponsiveFontSizeField: React.FC<ResponsiveFontSizeFieldProps> = ({
  canEdit,
  english,
  onChange,
  setting,
  siteLocales,
  value,
}) => {
  const spec = useMemo(() => responsiveSpecOf(setting), [setting])
  const [device, setDevice] = useState<TypographyBreakpoint>('desktop')
  const [locale, setLocale] = useState<'base' | TypographyLocale>('base')

  const localeOptions = useMemo(
    () =>
      (spec?.locales ?? []).filter((candidate) =>
        siteLocales.includes(candidate),
      ) as TypographyLocale[],
    [siteLocales, spec?.locales],
  )

  if (!spec) return null

  const activeLocale = locale !== 'base' && localeOptions.includes(locale) ? locale : 'base'
  const resolved = resolveResponsiveFontSize(spec, value, localeOptions)
  const layer: ResponsiveLayerResolution =
    activeLocale === 'base' ? resolved.base : resolved.locales[activeLocale] ?? resolved.base
  const layerValue =
    activeLocale === 'base' ? value : (value?.locales?.[activeLocale] ?? undefined)

  const setDeviceValue = (breakpoint: TypographyBreakpoint, next: number | undefined) => {
    const current = value ?? {}
    if (activeLocale === 'base') {
      const devices: ResponsiveDeviceValues = { ...current }
      if (next === undefined) delete devices[breakpoint]
      else devices[breakpoint] = next
      onChange(clean({ ...devices, ...(current.locales ? { locales: current.locales } : {}) }))
      return
    }
    const locales = { ...(current.locales ?? {}) }
    const devices: ResponsiveDeviceValues = { ...(locales[activeLocale] ?? {}) }
    if (next === undefined) delete devices[breakpoint]
    else devices[breakpoint] = next
    if (Object.keys(devices).length) locales[activeLocale] = devices
    else delete locales[activeLocale]
    onChange(clean({ ...current, locales }))
  }

  const resetDevice = () => setDeviceValue(device, undefined)
  const isExplicit = layerValue?.[device] !== undefined
  const label =
    (english ? (setting.labelEn ?? setting.labelFa) : (setting.labelFa ?? setting.labelEn)) ??
    setting.key
  const sampleText =
    activeLocale === 'en'
      ? 'The quick brown fox jumps over the lazy dog'
      : 'نمونهٔ متن عنوان برای بررسی اندازه و خوانایی'

  return (
    <div className="theme-typography">
      <div className="theme-typography__head">
        <div>
          <div className="theme-typography__title">{label}</div>
          {setting.help && <p className="theme-console__muted">{setting.help}</p>}
        </div>
        <span className="theme-typography__badge">
          {english ? 'px · responsive' : 'px · واکنش‌گرا'}
        </span>
      </div>

      <div className="theme-typography__tabs" role="group" aria-label={english ? 'Device' : 'دستگاه'}>
        {TYPOGRAPHY_BREAKPOINTS.map((candidate) => (
          <button
            aria-pressed={device === candidate}
            className="theme-tab"
            key={candidate}
            onClick={() => setDevice(candidate)}
            type="button"
          >
            {english ? DEVICE_LABELS[candidate].en : DEVICE_LABELS[candidate].fa}
            <span className="theme-tab__meta">{TYPOGRAPHY_DEVICE_WIDTHS[candidate]}px</span>
          </button>
        ))}
      </div>

      {localeOptions.length > 0 && (
        <div
          className="theme-typography__tabs theme-typography__tabs--locale"
          role="group"
          aria-label={english ? 'Language' : 'زبان'}
        >
          <button
            aria-pressed={activeLocale === 'base'}
            className="theme-tab theme-tab--small"
            onClick={() => setLocale('base')}
            type="button"
          >
            {english ? 'All languages' : 'همهٔ زبان‌ها'}
          </button>
          {localeOptions.map((candidate) => (
            <button
              aria-pressed={activeLocale === candidate}
              className="theme-tab theme-tab--small"
              key={candidate}
              onClick={() => setLocale(candidate)}
              type="button"
            >
              {english ? LOCALE_LABELS[candidate]?.en : LOCALE_LABELS[candidate]?.fa}
            </button>
          ))}
        </div>
      )}

      <div className="theme-typography__body">
        <div className="theme-typography__controls">
          {TYPOGRAPHY_BREAKPOINTS.map((candidate) => (
            <DeviceNumberInput
              canEdit={canEdit}
              device={candidate}
              english={english}
              explicit={layerValue?.[candidate]}
              idPrefix={`typography-${setting.key}`}
              key={`${activeLocale}-${candidate}`}
              label={english ? DEVICE_LABELS[candidate].en : DEVICE_LABELS[candidate].fa}
              max={spec.max}
              min={spec.min}
              onCommit={(next) => setDeviceValue(candidate, next)}
              resolved={layer[candidate].px}
              step={spec.step}
            />
          ))}
          <div className="theme-typography__actions">
            <span className="theme-typography__source">
              {english
                ? `${SOURCE_LABELS[layer[device].source].en} · ${layer[device].px}px`
                : `${SOURCE_LABELS[layer[device].source].fa} · ${formatNumber(layer[device].px, 'fa')} پیکسل`}
            </span>
            <button
              className="theme-link-button"
              disabled={!canEdit || !isExplicit}
              onClick={resetDevice}
              type="button"
            >
              {english ? 'Use inherited value' : 'استفاده از مقدار ارث‌بری‌شده'}
            </button>
          </div>
        </div>

        <figure className="theme-typography__sample">
          <span className="theme-typography__sample-meta">
            {english
              ? `${DEVICE_LABELS[device].en} · ${TYPOGRAPHY_DEVICE_WIDTHS[device]}px viewport`
              : `${DEVICE_LABELS[device].fa} · نمای ${formatNumber(TYPOGRAPHY_DEVICE_WIDTHS[device], 'fa')} پیکسل`}
          </span>
          <div
            aria-live="polite"
            className="theme-typography__sample-text"
            dir={activeLocale === 'en' ? 'ltr' : 'rtl'}
            style={{ fontSize: `${layer[device].px}px`, lineHeight: 1.6 }}
          >
            {sampleText}
          </div>
          <figcaption className="theme-typography__sample-note">
            {english
              ? 'Live sample of the resolved px value. Nothing is saved or published here.'
              : 'نمونهٔ زندهٔ مقدار نهایی بر حسب پیکسل. این‌جا چیزی ذخیره یا منتشر نمی‌شود.'}
          </figcaption>
        </figure>
      </div>
    </div>
  )
}

export default ResponsiveFontSizeField
