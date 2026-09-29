'use client'

import React, { useEffect, useState } from 'react'

import { Banner, Button, CheckboxInput, SelectInput, TextInput, toast } from '@payloadcms/ui'

import type { ThemeSettingsView } from '@/deploy/tenantSettings'
import { formatNumber } from '@/lib/format'
import {
  contentSlotCollectionSlug,
  fetchAllContentSlotOptions,
  type ContentOption,
  type ContentSlotType,
} from '@/deploy/admin/contentSlotOptions'

/**
 * The form behind «تنظیمات پوسته»: what the site's theme asks the customer for,
 * generated from its synced manifest, in three groups — deployment variables, display
 * options, and which of the site's documents fill the theme's sections.
 *
 * Built from Payload's own inputs (select, text, checkbox, banner, toast) so it reads
 * like every other edit screen. Each content slot has its own searchable select: the
 * old version shared one search box per *type*, so typing in «صفحه خانه» also filtered
 * «صفحه درباره», re-queried the server per keystroke, and a selection filtered out of
 * the list vanished from its box.
 *
 * Secrets are write-only. The server never sends their values — only whether one is
 * stored — so a secret box always starts empty, and an empty box on save means
 * "keep what is stored". Replacing it is typing a new value; removing it is the
 * explicit «حذف مقدار ذخیره‌شده» checkbox. What is typed shows in clear while typing:
 * the protection is at rest and on read, which the description says rather than
 * implying a mask that does not exist.
 */

const LOCALE_NAMES: Record<string, string> = { en: 'انگلیسی', fa: 'فارسی' }

export type ThemeSettingsFormProps = {
  initial: ThemeSettingsView
  siteId: string
  /** The languages the site serves; every bound page needs each of them. */
  siteLocales: string[]
  siteName: string
}

export const ThemeSettingsForm: React.FC<ThemeSettingsFormProps> = ({
  initial,
  siteId,
  siteLocales,
  siteName,
}) => {
  const [view, setView] = useState<ThemeSettingsView>(initial)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initial.fields
        .filter((field) => !field.secret)
        .map((field) => [field.key, field.value ?? '']),
    ),
  )
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clear, setClear] = useState<Record<string, boolean>>({})
  const [runtimeSettings, setRuntimeSettings] = useState<Record<string, boolean | number | string>>(
    initial.runtimeSettings,
  )
  const [bindings, setBindings] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initial.bindings).flatMap(([key, value]) => {
        const id = value && typeof value === 'object' ? (value as { id?: unknown }).id : value
        return typeof id === 'string' ? [[key, id]] : []
      }),
    ),
  )
  const [contentOptions, setContentOptions] = useState<Record<string, ContentOption[]>>({})
  const [contentLoadError, setContentLoadError] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<null | string>(null)

  const slotTypeKey = [...new Set(initial.contentSlots.map((slot) => slot.type))].join(',')

  /**
   * Every bindable document, once per type. The select filters as the user types, in the
   * browser — the lists are one site's pages and categories, not a catalogue.
   */
  useEffect(() => {
    const controller = new AbortController()
    const slotTypes = (slotTypeKey ? slotTypeKey.split(',') : []) as ContentSlotType[]

    const fetchPage =
      (type: ContentSlotType) =>
      async ({ page }: { page: number }) => {
        const slug = contentSlotCollectionSlug[type]
        const params = new URLSearchParams({ depth: '0', limit: '100', page: String(page) })
        const response = await fetch(`/api/${slug}?${params}`, {
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(String(response.status))
        return (await response.json()) as {
          docs?: Record<string, unknown>[]
          hasNextPage?: boolean
          nextPage?: null | number
        }
      }

    void Promise.all(
      slotTypes.map(async (type) => {
        try {
          const options = await fetchAllContentSlotOptions(fetchPage(type), type)
          return [type, options, false] as const
        } catch {
          return [type, [], true] as const
        }
      }),
    )
      .then((entries) => {
        setContentOptions(
          Object.fromEntries(entries.map(([type, options]) => [type, options])) as Record<
            string,
            ContentOption[]
          >,
        )
        setContentLoadError(Object.fromEntries(entries.map(([type, , failed]) => [type, failed])))
      })
      .catch(() => undefined)

    return () => controller.abort()
  }, [slotTypeKey])

  if (!view.package) {
    return (
      <div className="theme-console">
        <h1>تنظیمات پوسته — {siteName}</h1>
        <Banner type="info">
          این سایت با رندرکنندهٔ داخلی سکو نمایش داده می‌شود و پوستهٔ نصب‌شدنی‌ای ندارد که تنظیماتی
          بخواهد. انتخاب و استقرار پوسته با پشتیبانی سکو است.
        </Banner>
      </div>
    )
  }

  if (
    view.fields.length === 0 &&
    view.runtimeSchema.length === 0 &&
    view.contentSlots.length === 0
  ) {
    return (
      <div className="theme-console">
        <h1>تنظیمات پوسته — {siteName}</h1>
        <Banner type="info">پوستهٔ «{view.package.name}» از شما مقداری نمی‌خواهد.</Banner>
      </div>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!view.canEdit) return

    setPending(true)
    setError(null)

    const submitted: Record<string, string> = { ...values }
    for (const [key, value] of Object.entries(secrets)) if (value.trim()) submitted[key] = value

    try {
      const response = await fetch('/api/site-theme-settings/current', {
        body: JSON.stringify({
          clear: Object.entries(clear)
            .filter(([, checked]) => checked)
            .map(([key]) => key),
          site: siteId,
          bindings: Object.fromEntries(Object.entries(bindings).filter(([, id]) => id)),
          runtimeSettings,
          values: submitted,
        }),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const payload = (await response.json().catch(() => ({}))) as Partial<ThemeSettingsView> & {
        message?: string
      }

      if (!response.ok) {
        setError(payload.message ?? `ذخیره ناموفق بود (${response.status}).`)
        return
      }

      if (payload.fields && payload.package !== undefined) {
        setView(payload as ThemeSettingsView)
        setRuntimeSettings(payload.runtimeSettings ?? {})
      }
      setSecrets({})
      setClear({})
      toast.success(payload.message ?? 'ذخیره شد.')
    } catch {
      setError('ارتباط با سرور برقرار نشد.')
    } finally {
      setPending(false)
    }
  }

  const optionLabel = (setting: { labelEn?: null | string; labelFa?: null | string; key: string }) =>
    setting.labelFa ?? setting.labelEn ?? setting.key
  const siteLanguages = siteLocales.map((code) => LOCALE_NAMES[code] ?? code)

  return (
    <form className="theme-console theme-form" onSubmit={submit}>
      <div className="theme-console__intro">
        <h1>تنظیمات پوسته — {siteName}</h1>
        <p className="theme-console__muted">
          پوستهٔ فعال: «{view.package.name}». گزینه‌های نمایش و نگاشت محتوا بلافاصله پس از ذخیره
          روی سایت اعمال می‌شوند؛ متغیرهای استقرار در استقرار بعدی.
        </p>
      </div>

      {!view.canEdit && <Banner type="info">فقط مالک سایت می‌تواند این مقادیر را تغییر دهد.</Banner>}

      {view.fields.length > 0 && (
        <section className="theme-card">
          <div className="theme-card__head">
            <h2 className="theme-card__title">متغیرهای استقرار</h2>
          </div>
          <p className="theme-console__muted">
            مقادیری که پوسته هنگام ساخت و اجرا لازم دارد. تغییر آن‌ها پس از «اجرای دوبارهٔ نسخهٔ
            فعلی» در صفحهٔ استقرار اعمال می‌شود.
          </p>
          <div className="theme-form__fields">
            {view.fields.map((field) =>
              field.secret ? (
                <div className="theme-form__fields" key={field.key}>
                  <TextInput
                    description={[
                      field.help,
                      field.set
                        ? 'مقداری ذخیره شده و نمایش داده نمی‌شود. برای تغییر، مقدار تازه را وارد کنید؛ خالی ماندن یعنی بدون تغییر.'
                        : 'محرمانه — رمزنگاری‌شده ذخیره می‌شود و پس از ذخیره دیگر نمایش داده نمی‌شود.',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    htmlAttributes={{ autoComplete: 'off' }}
                    label={field.label}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      setSecrets((prev) => ({ ...prev, [field.key]: event.target.value }))
                    }
                    path={`secret-${field.key}`}
                    placeholder={field.set ? '•••••••• (ذخیره شده)' : ''}
                    readOnly={!view.canEdit || clear[field.key] === true}
                    required={field.required && !field.set}
                    rtl={false}
                    value={secrets[field.key] ?? ''}
                  />
                  {field.set && view.canEdit && (
                    <CheckboxInput
                      checked={clear[field.key] === true}
                      label="حذف مقدار ذخیره‌شده"
                      name={`clear-${field.key}`}
                      onToggle={(event) =>
                        setClear((prev) => ({ ...prev, [field.key]: event.target.checked }))
                      }
                    />
                  )}
                </div>
              ) : (
                <TextInput
                  description={field.help ?? undefined}
                  key={field.key}
                  label={field.label}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                  }
                  path={`value-${field.key}`}
                  readOnly={!view.canEdit}
                  required={field.required}
                  rtl={false}
                  value={values[field.key] ?? ''}
                />
              ),
            )}
          </div>
        </section>
      )}

      {view.runtimeSchema.length > 0 && (
        <section className="theme-card">
          <div className="theme-card__head">
            <h2 className="theme-card__title">گزینه‌های نمایش</h2>
          </div>
          <div className="theme-form__fields">
            {view.runtimeSchema.map((setting) => {
              const label = optionLabel(setting)
              const set = (value: boolean | number | string | undefined) =>
                setRuntimeSettings((previous) => {
                  const next = { ...previous }
                  if (value === undefined || value === '') delete next[setting.key]
                  else next[setting.key] = value
                  return next
                })

              if (setting.type === 'boolean') {
                return (
                  <CheckboxInput
                    checked={runtimeSettings[setting.key] === true}
                    key={setting.key}
                    label={label}
                    name={`runtime-${setting.key}`}
                    onToggle={(event) => set(event.target.checked)}
                    readOnly={!view.canEdit}
                  />
                )
              }
              if (setting.type === 'select') {
                return (
                  <SelectInput
                    description={setting.help ?? undefined}
                    isClearable
                    key={setting.key}
                    label={label}
                    name={`runtime-${setting.key}`}
                    onChange={(option) =>
                      set((option as { value?: string } | null)?.value ?? undefined)
                    }
                    options={(setting.options ?? []).map((option) => ({
                      label: option.labelFa ?? option.labelEn ?? option.value,
                      value: option.value,
                    }))}
                    path={`runtime-${setting.key}`}
                    readOnly={!view.canEdit}
                    value={String(runtimeSettings[setting.key] ?? '')}
                  />
                )
              }
              if (setting.type === 'number') {
                const range = [
                  typeof setting.min === 'number' ? `کمینه ${formatNumber(setting.min, 'fa')}` : '',
                  typeof setting.max === 'number' ? `بیشینه ${formatNumber(setting.max, 'fa')}` : '',
                ]
                  .filter(Boolean)
                  .join('، ')
                return (
                  <TextInput
                    description={[setting.help, range].filter(Boolean).join(' — ') || undefined}
                    key={setting.key}
                    label={label}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      const raw = event.target.value.trim()
                      const number = Number(raw)
                      set(raw === '' || Number.isNaN(number) ? undefined : number)
                    }}
                    path={`runtime-${setting.key}`}
                    readOnly={!view.canEdit}
                    rtl={false}
                    value={String(runtimeSettings[setting.key] ?? '')}
                  />
                )
              }
              return (
                <TextInput
                  description={setting.help ?? undefined}
                  key={setting.key}
                  label={label}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => set(event.target.value)}
                  path={`runtime-${setting.key}`}
                  readOnly={!view.canEdit}
                  value={String(runtimeSettings[setting.key] ?? '')}
                />
              )
            })}
          </div>
        </section>
      )}

      {view.contentSlots.length > 0 && (
        <section className="theme-card">
          <div className="theme-card__head">
            <h2 className="theme-card__title">نگاشت محتوای پوسته</h2>
          </div>
          <p className="theme-console__muted">
            کدام صفحه یا دستهٔ این سایت هر بخش پوسته را پر کند.
            {siteLanguages.length > 1 && (
              <>
                {' '}
                این سایت به زبان‌های <strong>{siteLanguages.join('، ')}</strong> ارائه می‌شود و
                هر صفحهٔ انتخاب‌شده باید به همهٔ آن‌ها ترجمه و منتشر شده باشد. ترجمه در ویرایشگر
                خود صفحه انجام می‌شود (انتخابگر زبان بالای صفحه)، نه این‌جا؛ زبان‌های سایت در{' '}
                <a href={`/admin/collections/sites/${siteId}`}>تنظیمات سایت</a> تعیین می‌شوند.
              </>
            )}
          </p>
          <div className="theme-form__fields">
            {view.contentSlots.map((slot) => {
              const type = slot.type as ContentSlotType
              const bound = bindings[slot.key]
              const options = contentOptions[type] ?? []
              const collection = contentSlotCollectionSlug[type]
              return (
                <div className="theme-form__fields" key={slot.key}>
                  <SelectInput
                    description={
                      contentLoadError[type]
                        ? 'بارگذاری فهرست ناموفق بود؛ صفحه را دوباره بارگذاری کنید.'
                        : (slot.help ?? undefined)
                    }
                    isClearable={!slot.required}
                    label={optionLabel(slot)}
                    name={`binding-${slot.key}`}
                    onChange={(option) =>
                      setBindings((previous) => {
                        const next = { ...previous }
                        const value = (option as { value?: string } | null)?.value
                        if (value) next[slot.key] = value
                        else delete next[slot.key]
                        return next
                      })
                    }
                    options={options.map((option) => ({ label: option.label, value: option.id }))}
                    path={`binding-${slot.key}`}
                    placeholder={slot.required ? 'انتخاب کنید' : 'بدون نگاشت'}
                    readOnly={!view.canEdit}
                    required={slot.required}
                    value={bound ?? ''}
                  />
                  {bound && collection && (
                    <a
                      className="theme-console__muted"
                      href={`/admin/collections/${collection}/${encodeURIComponent(bound)}`}
                      style={{ fontSize: '0.85rem' }}
                    >
                      ویرایش و ترجمهٔ همین محتوا ←
                    </a>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {error && <Banner type="error">{error}</Banner>}

      {view.canEdit && (
        <div className="theme-form__footer">
          <Button buttonStyle="primary" disabled={pending} type="submit">
            {pending ? 'در حال ذخیره…' : 'ذخیرهٔ تنظیمات'}
          </Button>
        </div>
      )}
    </form>
  )
}

export default ThemeSettingsForm
