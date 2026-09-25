'use client'

import React, { useState } from 'react'

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

export const ThemeSettingsForm: React.FC<ThemeSettingsFormProps> = ({ initial, siteId, siteName }) => {
  const [view, setView] = useState<ThemeSettingsView>(initial)
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.fields.filter((field) => !field.secret).map((field) => [field.key, field.value ?? ''])),
  )
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [clear, setClear] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<null | Result>(null)

  if (!view.package) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem' }}>
        <h1>تنظیمات پوسته — {siteName}</h1>
        <div className="banner banner--type-default">
          این سایت با رندرکنندهٔ داخلی سکو نمایش داده می‌شود و پوستهٔ نصب‌شدنی‌ای ندارد که تنظیماتی بخواهد.
          انتخاب و استقرار پوسته با پشتیبانی سکو است.
        </div>
      </div>
    )
  }

  if (view.fields.length === 0) {
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
        setView({ canEdit: Boolean(payload.canEdit), fields: payload.fields, package: payload.package })
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
          پوستهٔ فعال: «{view.package.name}». این مقادیر را خود پوسته از شما خواسته است و در استقرار بعدی
          روی آن اعمال می‌شوند.
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
                onToggle={(event) => setClear((prev) => ({ ...prev, [field.key]: event.target.checked }))}
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

      {result && (
        <div className={`banner banner--type-${result.ok ? 'success' : 'error'}`}>{result.text}</div>
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
