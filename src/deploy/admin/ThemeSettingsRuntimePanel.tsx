'use client'

import React, { useMemo, useState } from 'react'

import {
  Banner,
  CheckboxInput,
  SelectInput,
  TextInput,
} from '@payloadcms/ui'

import type { ManifestRuntimeSetting, RuntimeSettingValue } from '@/lib/deploy/manifest'
import {
  groupRuntimeSettings,
  SETTING_CATEGORY_LABELS,
  settingSectionLabel,
  type SettingCategory,
} from '@/lib/deploy/theme-settings'
import { formatNumber } from '@/lib/format'

import { ResponsiveFontSizeField } from './ResponsiveFontSizeField'

/**
 * The manifest's design/general settings, rendered as categorized sections instead
 * of one long input stack.
 *
 * The categories come from the manifest (`category`/`section`) with a deterministic
 * key-based fallback for manifests written before those fields existed. The form is
 * one component for every theme: a theme describes its settings, it never ships an
 * admin page, and it cannot name a component for the CMS to load.
 *
 * Search, category and open/closed section state all live here, so switching them
 * never touches the values the parent is holding — an unsaved edit survives a look at
 * another section.
 */

export type ThemeSettingsRuntimePanelProps = {
  canEdit: boolean
  defaults: Record<string, RuntimeSettingValue>
  english: boolean
  legacyKeys: string[]
  onChange: (key: string, value: RuntimeSettingValue | undefined) => void
  onReset: (keys: string[]) => void
  schema: ManifestRuntimeSetting[]
  siteLocales: string[]
  values: Record<string, RuntimeSettingValue>
}

const settingLabel = (setting: ManifestRuntimeSetting, english: boolean): string =>
  (english ? (setting.labelEn ?? setting.labelFa) : (setting.labelFa ?? setting.labelEn)) ??
  setting.key

const ScalarNumberInput: React.FC<{
  canEdit: boolean
  id: string
  max?: number
  min?: number
  onChange: (value: number | undefined) => void
  step?: number
  value: number | undefined
}> = ({ canEdit, id, max, min, onChange, step, value }) => {
  const [error, setError] = useState<null | string>(null)
  const commit = (raw: string) => {
    if (raw.trim() === '') {
      setError(null)
      onChange(undefined)
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      setError('یک عدد وارد کنید.')
      return
    }
    if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      setError(`باید بین ${formatNumber(min ?? 0, 'fa')} و ${formatNumber(max ?? 0, 'fa')} باشد.`)
      return
    }
    setError(null)
    onChange(parsed)
  }
  return (
    <div>
      <div className={`theme-number__control${error ? ' theme-number__control--error' : ''}`}>
        <input
          aria-invalid={Boolean(error)}
          disabled={!canEdit}
          id={id}
          inputMode="decimal"
          max={max}
          min={min}
          onChange={(event) => commit(event.target.value)}
          step={step ?? 1}
          type="number"
          value={value === undefined ? '' : String(value)}
        />
      </div>
      {error && (
        <span className="theme-number__error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

const FieldControl: React.FC<{
  canEdit: boolean
  defaultValue: RuntimeSettingValue | undefined
  english: boolean
  onChange: (value: RuntimeSettingValue | undefined) => void
  setting: ManifestRuntimeSetting
  siteLocales: string[]
  value: RuntimeSettingValue | undefined
}> = ({ canEdit, defaultValue, english, onChange, setting, siteLocales, value }) => {
  const id = `runtime-${setting.key}`

  if (setting.type === 'responsiveFontSize') {
    return (
      <ResponsiveFontSizeField
        canEdit={canEdit}
        english={english}
        onChange={(next) => onChange(next)}
        setting={setting}
        siteLocales={siteLocales}
        value={
          value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : undefined
        }
      />
    )
  }

  if (setting.type === 'boolean') {
    return (
      <CheckboxInput
        checked={typeof value === 'boolean' ? value : defaultValue === true}
        label={settingLabel(setting, english)}
        name={id}
        onToggle={(event) => onChange(event.target.checked)}
        readOnly={!canEdit}
      />
    )
  }

  if (setting.type === 'select') {
    return (
      <SelectInput
        description={setting.help ?? undefined}
        isClearable={canEdit}
        label={settingLabel(setting, english)}
        name={id}
        onChange={(option) => onChange((option as { value?: string } | null)?.value)}
        options={(setting.options ?? []).map((option) => ({
          label:
            (english ? option.labelEn ?? option.labelFa : option.labelFa ?? option.labelEn) ??
            option.value,
          value: option.value,
        }))}
        path={id}
        readOnly={!canEdit}
        value={typeof value === 'string' ? value : ''}
      />
    )
  }

  if (setting.type === 'number') {
    return (
      <div>
        <label className="theme-number__label" htmlFor={id}>
          {settingLabel(setting, english)}
        </label>
        <ScalarNumberInput
          canEdit={canEdit}
          id={id}
          max={setting.max}
          min={setting.min}
          onChange={onChange}
          step={setting.step}
          value={typeof value === 'number' ? value : undefined}
        />
        {setting.help && <p className="theme-console__muted">{setting.help}</p>}
      </div>
    )
  }

  return (
    <TextInput
      description={setting.help ?? undefined}
      label={settingLabel(setting, english)}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      path={id}
      readOnly={!canEdit}
      value={typeof value === 'string' ? value : ''}
    />
  )
}

export const ThemeSettingsRuntimePanel: React.FC<ThemeSettingsRuntimePanelProps> = ({
  canEdit,
  defaults,
  english,
  legacyKeys,
  onChange,
  onReset,
  schema,
  siteLocales,
  values,
}) => {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<null | SettingCategory>(null)
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const [confirmingReset, setConfirmingReset] = useState(false)

  const groups = useMemo(() => groupRuntimeSettings(schema, { query }), [query, schema])
  const activeCategory =
    category && groups.some((group) => group.category === category)
      ? category
      : (groups[0]?.category ?? null)
  const active = groups.find((group) => group.category === activeCategory) ?? null

  const declaredLegacy = legacyKeys.filter((key) =>
    schema.some((setting) => setting.key === key),
  )
  const explicitCount = schema.filter((setting) => values[setting.key] !== undefined).length

  if (schema.length === 0) return <Banner type="info">این پوسته گزینهٔ نمایشی ندارد.</Banner>

  const sectionOpen = (key: string, index: number): boolean => {
    if (query.trim()) return true
    return openSections[`${activeCategory}:${key}`] ?? index === 0
  }

  return (
    <section className="theme-card theme-runtime">
      <div className="theme-card__head">
        <h2 className="theme-card__title">
          {english ? 'Display options' : 'گزینه‌های نمایش'}
          <span className="theme-runtime__count">
            {formatNumber(schema.length, english ? 'en' : 'fa')}
          </span>
        </h2>
        {canEdit && explicitCount > 0 && (
          <button
            className="theme-link-button"
            onClick={() => setConfirmingReset(true)}
            type="button"
          >
            {english ? 'Restore theme defaults' : 'بازگرداندن پیش‌فرض‌های پوسته'}
          </button>
        )}
      </div>

      {confirmingReset && (
        <div className="theme-confirm" role="alertdialog" aria-label={english ? 'Confirm reset' : 'تأیید بازنشانی'}>
          <p>
            {english
              ? `This clears ${explicitCount} saved option(s) in this page and uses the theme defaults. Nothing else changes.`
              : `${formatNumber(explicitCount, 'fa')} گزینهٔ ذخیره‌شده در این صفحه پاک و پیش‌فرض پوسته اعمال می‌شود. بخش‌های دیگر تغییر نمی‌کنند.`}
          </p>
          <div className="theme-confirm__actions">
            <button
              className="theme-link-button"
              onClick={() => setConfirmingReset(false)}
              type="button"
            >
              {english ? 'Cancel' : 'انصراف'}
            </button>
            <button
              className="theme-link-button theme-link-button--danger"
              onClick={() => {
                onReset(schema.map((setting) => setting.key))
                setConfirmingReset(false)
              }}
              type="button"
            >
              {english ? 'Reset and keep editing' : 'بازنشانی و ادامهٔ ویرایش'}
            </button>
          </div>
        </div>
      )}

      {declaredLegacy.length > 0 && (
        <Banner type="info">
          {english
            ? 'A value saved for an older version of this option is preserved and is not read as px: '
            : 'مقدار ذخیره‌شده از نسخهٔ قدیمی این گزینه حفظ شده و به‌صورت پیکسل خوانده نمی‌شود: '}
          <strong>{declaredLegacy.join('، ')}</strong>
          {english
            ? '. Saving a new px value here replaces it.'
            : '. با ذخیرهٔ مقدار پیکسل جدید، جایگزین می‌شود.'}
        </Banner>
      )}

      <div className="theme-runtime__toolbar">
        <input
          aria-label={english ? 'Search settings' : 'جست‌وجو در گزینه‌ها'}
          className="theme-runtime__search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={english ? 'Search by name…' : 'جست‌وجو بر اساس نام…'}
          type="search"
          value={query}
        />
        <div className="theme-runtime__nav" role="tablist" aria-label={english ? 'Categories' : 'دسته‌بندی‌ها'}>
          {groups.map((group) => (
            <button
              aria-selected={group.category === activeCategory}
              className="theme-chip"
              key={group.category}
              onClick={() => setCategory(group.category)}
              role="tab"
              type="button"
            >
              {english
                ? SETTING_CATEGORY_LABELS[group.category].en
                : SETTING_CATEGORY_LABELS[group.category].fa}
              <span className="theme-chip__count">{formatNumber(group.count, english ? 'en' : 'fa')}</span>
            </button>
          ))}
        </div>
      </div>

      {!active && (
        <Banner type="info">
          {english ? 'No setting matches this search.' : 'گزینه‌ای با این جست‌وجو پیدا نشد.'}
        </Banner>
      )}

      {active && (
        <div className="theme-runtime__sections">
          {active.sections.map((section, index) => {
            const open = sectionOpen(section.key, index)
            const sectionKeys = section.settings.map((setting) => setting.key)
            const hasExplicit = sectionKeys.some((key) => values[key] !== undefined)
            return (
              <section className="theme-section" key={section.key}>
                <div className="theme-section__head">
                  <button
                    aria-expanded={open}
                    className="theme-section__toggle"
                    onClick={() =>
                      setOpenSections((previous) => ({
                        ...previous,
                        [`${activeCategory}:${section.key}`]: !open,
                      }))
                    }
                    type="button"
                  >
                    <span aria-hidden="true" className="theme-section__chevron">
                      {open ? '▾' : '▸'}
                    </span>
                    {settingSectionLabel(section.key, english)}
                    <span className="theme-runtime__count">
                      {formatNumber(section.count, english ? 'en' : 'fa')}
                    </span>
                  </button>
                  {canEdit && hasExplicit && (
                    <button
                      className="theme-link-button"
                      onClick={() => onReset(sectionKeys)}
                      type="button"
                    >
                      {english ? 'Reset section' : 'بازنشانی این بخش'}
                    </button>
                  )}
                </div>

                {open && (
                  <div className="theme-section__body">
                    {section.settings.map((setting) => {
                      const value = values[setting.key]
                      const defaultValue = defaults[setting.key]
                      return (
                        <div
                          className="theme-field"
                          data-advanced={setting.advanced ? 'true' : undefined}
                          key={setting.key}
                        >
                          <div className="theme-field__label-row">
                            {value !== undefined && canEdit && (
                              <button
                                className="theme-link-button theme-link-button--small"
                                onClick={() => onChange(setting.key, undefined)}
                                type="button"
                              >
                                {english ? 'Reset' : 'بازنشانی'}
                              </button>
                            )}
                          </div>
                          <FieldControl
                            canEdit={canEdit}
                            defaultValue={defaultValue}
                            english={english}
                            onChange={(next) => onChange(setting.key, next)}
                            setting={setting}
                            siteLocales={siteLocales}
                            value={value}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default ThemeSettingsRuntimePanel
