'use client'

import React, { useEffect, useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'
import { CheckboxInput } from '@payloadcms/ui/fields/Checkbox'
import { TextInput } from '@payloadcms/ui/fields/Text'

import type { ThemeSettingsView } from '@/deploy/tenantSettings'

/**
 * The form behind «تنظیمات پوسته»: one box per variable the site's theme asked the
 * customer for, generated from its synced manifest.
 *
 * Secrets are write-only. The server never sends their values — only whether one is
 * stored — so a secret box always starts empty, and an empty box on save means
 * "keep what is stored". Replacing it is typing a new value; removing it is the
 * explicit «حذف مقدار ذخیره‌شده» checkbox. What is typed shows in clear while typing:
 * the protection is at rest and on read, which the description says rather than
 * implying a mask that does not exist.
 */

export type ThemeSettingsFormProps = {
  initial: ThemeSettingsView
  siteId: string
  siteName: string
}

type Result = { ok: boolean; text: string }
type ContentOption = { id: string; label: string }

export const ThemeSettingsForm: React.FC<ThemeSettingsFormProps> = ({
  initial,
  siteId,
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
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<null | Result>(null)

  useEffect(() => {
    const collections = [...new Set(initial.contentSlots.map((slot) => slot.type))]
    const controller = new AbortController()
    const collectionSlug = {
      category: 'categories',
      form: 'forms',
      media: 'media',
      page: 'pages',
      post: 'posts',
    } as const

    void Promise.all(
      collections.map(async (type) => {
        const response = await fetch(`/api/${collectionSlug[type]}?limit=100&depth=0`, {
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (!response.ok) return [type, []] as const
        const payload = (await response.json()) as { docs?: Record<string, unknown>[] }
        const options = (payload.docs ?? []).flatMap((doc) => {
          const id = typeof doc.id === 'string' ? doc.id : null
          const label = doc.title ?? doc.name ?? doc.filename ?? doc.slug
          return id && typeof label === 'string' ? [{ id, label }] : []
        })
        return [type, options] as const
      }),
    )
      .then((entries) => setContentOptions(Object.fromEntries(entries)))
      .catch(() => undefined)

    return () => controller.abort()
  }, [initial.contentSlots])

  if (!view.package) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem' }}>
        <h1>تنظیمات پوسته — {siteName}</h1>
        <div className="banner banner--type-default">
          این سایت با رندرکنندهٔ داخلی سکو نمایش داده می‌شود و پوستهٔ نصب‌شدنی‌ای ندارد که تنظیماتی
          بخواهد. انتخاب و استقرار پوسته با پشتیبانی سکو است.
        </div>
      </div>
    )
  }

  if (
    view.fields.length === 0 &&
    view.runtimeSchema.length === 0 &&
    view.contentSlots.length === 0
  ) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem' }}>
        <h1>تنظیمات پوسته — {siteName}</h1>
        <div className="banner banner--type-default">
          پوستهٔ «{view.package.name}» از شما مقداری نمی‌خواهد.
        </div>
      </div>
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!view.canEdit) return

    setPending(true)
    setResult(null)

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
        setResult({ ok: false, text: payload.message ?? `ذخیره ناموفق بود (${response.status}).` })
        return
      }

      if (payload.fields && payload.package !== undefined) {
        setView(payload as ThemeSettingsView)
        setRuntimeSettings(payload.runtimeSettings ?? {})
      }
      setSecrets({})
      setClear({})
      setResult({ ok: true, text: payload.message ?? 'ذخیره شد.' })
    } catch {
      setResult({ ok: false, text: 'ارتباط با سرور برقرار نشد.' })
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem' }}
    >
      <div>
        <h1>تنظیمات پوسته — {siteName}</h1>
        <p style={{ color: 'var(--theme-elevation-600)' }}>
          پوستهٔ فعال: «{view.package.name}». گزینه‌های نمایش و نگاشت محتوا بدون استقرار مجدد اعمال
          می‌شوند؛ متغیرهای زیر در استقرار بعدی وارد محیط اجرا می‌شوند.
        </p>
      </div>

      {!view.canEdit && (
        <div className="banner banner--type-default">
          فقط مالک سایت می‌تواند این مقادیر را تغییر دهد.
        </div>
      )}

      {view.fields.map((field) =>
        field.secret ? (
          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
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
              label={`${field.label} (${field.key})`}
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
            label={`${field.label} (${field.key})`}
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

      {view.runtimeSchema.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h2>گزینه‌های فعال پوسته</h2>
          {view.runtimeSchema.map((setting) => {
            const label = setting.labelFa ?? setting.labelEn ?? setting.key
            if (setting.type === 'boolean') {
              return (
                <CheckboxInput
                  checked={runtimeSettings[setting.key] === true}
                  key={setting.key}
                  label={label}
                  name={`runtime-${setting.key}`}
                  onToggle={(event) =>
                    setRuntimeSettings((previous) => ({
                      ...previous,
                      [setting.key]: event.target.checked,
                    }))
                  }
                />
              )
            }
            if (setting.type === 'select') {
              return (
                <label
                  key={setting.key}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
                >
                  <span>{label}</span>
                  <select
                    disabled={!view.canEdit}
                    onChange={(event) =>
                      setRuntimeSettings((previous) => {
                        const next = { ...previous }
                        if (event.target.value) next[setting.key] = event.target.value
                        else delete next[setting.key]
                        return next
                      })
                    }
                    value={String(runtimeSettings[setting.key] ?? '')}
                  >
                    <option value="">انتخاب کنید</option>
                    {setting.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.labelFa ?? option.labelEn ?? option.value}
                      </option>
                    ))}
                  </select>
                </label>
              )
            }
            if (setting.type === 'number') {
              return (
                <label
                  key={setting.key}
                  style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
                >
                  <span>{label}</span>
                  <input
                    disabled={!view.canEdit}
                    max={setting.max}
                    min={setting.min}
                    onChange={(event) =>
                      setRuntimeSettings((previous) => {
                        const next = { ...previous }
                        if (event.target.value) next[setting.key] = Number(event.target.value)
                        else delete next[setting.key]
                        return next
                      })
                    }
                    type="number"
                    value={String(runtimeSettings[setting.key] ?? '')}
                  />
                  {setting.help && <small>{setting.help}</small>}
                </label>
              )
            }
            return (
              <TextInput
                description={setting.help ?? undefined}
                key={setting.key}
                label={label}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setRuntimeSettings((previous) => ({
                    ...previous,
                    [setting.key]: event.target.value,
                  }))
                }
                path={`runtime-${setting.key}`}
                readOnly={!view.canEdit}
                value={String(runtimeSettings[setting.key] ?? '')}
              />
            )
          })}
        </section>
      )}

      {view.contentSlots.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h2>نگاشت محتوای پوسته</h2>
          {view.contentSlots.map((slot) => (
            <label
              key={slot.key}
              style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}
            >
              <span>{slot.labelFa ?? slot.labelEn ?? slot.key}</span>
              <select
                disabled={!view.canEdit}
                onChange={(event) =>
                  setBindings((previous) => ({ ...previous, [slot.key]: event.target.value }))
                }
                required={slot.required}
                value={bindings[slot.key] ?? ''}
              >
                <option value="">{slot.required ? 'انتخاب کنید' : 'بدون نگاشت'}</option>
                {(contentOptions[slot.type] ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {slot.help && <small>{slot.help}</small>}
            </label>
          ))}
        </section>
      )}

      {result && (
        <div className={`banner banner--type-${result.ok ? 'success' : 'error'}`}>
          {result.text}
        </div>
      )}

      {view.canEdit && (
        <div>
          <Button buttonStyle="primary" disabled={pending} type="submit">
            {pending ? 'در حال ذخیره…' : 'ذخیرهٔ تنظیمات'}
          </Button>
        </div>
      )}
    </form>
  )
}

export default ThemeSettingsForm
