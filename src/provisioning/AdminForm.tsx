'use client'

import React, { useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'

import { TextInput } from '@payloadcms/ui/fields/Text'
import { SelectInput } from '@payloadcms/ui/fields/Select'

import type { InviteUser } from './provisionSite'

/** `@payloadcms/ui` option shape — `{ label, value }`. */
type Option = { label: string; value: string }

const TYPE_OPTIONS: Option[] = [
  { label: 'کسب‌وکار', value: 'business' },
  { label: 'نمونه‌کار', value: 'portfolio' },
  { label: 'فروشگاه', value: 'store' },
]

const LOCALE_OPTIONS: Option[] = [
  { label: 'فارسی', value: 'fa' },
  { label: 'English', value: 'en' },
]

const ROLE_OPTIONS: Option[] = [
  { label: 'مالک — می‌تواند منتشر کند', value: 'owner' },
  { label: 'ویرایشگر — فقط پیش‌نویس', value: 'editor' },
]

type FieldErrors = Record<string, string>

type SuccessResult = {
  site: {
    adminUrl: string
    availableLocales: string[]
    defaultLocale: string
    domain: string
    id: string
    name: string
    type: string
    url: string
  }
  summary: { forms: number; footers: number; headers: number; pages: number; themes: number; users: number }
  users: { email: string; isNew: boolean; role: string }[]
}

/** Payload's own field-error markup, so server errors look native next to inputs. */
const FieldError = ({ message }: { message: string }) => (
  <div className="field-error">
    <span>{message}</span>
  </div>
)

const rowStyle: React.CSSProperties = {
  alignItems: 'flex-end',
  display: 'flex',
  gap: '0.75rem',
}

/**
 * The one-action form (Wave 5): name, domain, type, locales and the client's
 * users, posted to `/api/provision-site`. Everything else — pages, nav, footer,
 * theme, translations, invites — is the action's job, not the operator's.
 *
 * Plain React state, not Payload's form machinery: this form belongs to no
 * collection, and the admin's own inputs (`TextInput`, `SelectInput`) carry the
 * styling without a `Form` context.
 */
export const ProvisionSiteForm: React.FC = () => {
  const [name, setName] = useState('')
  const [domain, setDomain] = useState('')
  const [type, setType] = useState('business')
  const [locales, setLocales] = useState<string[]>(['fa'])
  const [defaultLocale, setDefaultLocale] = useState('fa')
  const [users, setUsers] = useState<InviteUser[]>([{ email: '', role: 'owner' }])

  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<SuccessResult | null>(null)

  /** A locale list change keeps `defaultLocale` inside it — the same rule `sites` enforces. */
  const changeLocales = (next: string[]) => {
    setLocales(next)

    if (!next.includes(defaultLocale)) setDefaultLocale(next[0] ?? 'fa')
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setPending(true)
    setErrors({})
    setMessage(null)

    try {
      const response = await fetch('/api/provision-site', {
        body: JSON.stringify({
          defaultLocale,
          domain,
          locales,
          name,
          type,
          users: users.filter(({ email }) => email.trim()),
        }),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const json = await response.json()

      if (!response.ok) {
        // Field errors arrive as `{ path, message }` — one per input.
        const fieldErrors: FieldErrors = {}

        for (const error of json.errors ?? []) {
          if (typeof error?.path === 'string' && typeof error?.message === 'string') {
            fieldErrors[error.path] = error.message
          }
        }

        setErrors(fieldErrors)
        setMessage(json.message ?? 'ساخت سایت ناموفق بود.')
        setResult(null)
        return
      }

      setResult(json as SuccessResult)
    } catch {
      setMessage('ارتباط با سرور برقرار نشد.')
    } finally {
      setPending(false)
    }
  }

  if (result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem' }}>
        <div className="banner banner--success">
          سایت «{result.site.name}» ساخته شد و با محتوای اولیه پر شد.
        </div>

        <p>
          {result.summary.pages} برگه، {result.summary.headers} سربرگ، {result.summary.footers} پابرگ،{' '}
          {result.summary.themes} پوسته و {result.summary.forms} فرم برای هر زبان سایت ساخته شد؛
          {' '}
          {result.summary.users} کاربر دعوت شد.
        </p>

        <ul>
          {result.users.map(({ email, isNew, role }) => (
            <li key={email}>
              {email} — {role === 'owner' ? 'مالک' : 'ویرایشگر'}
              {isNew ? ' (دعوت‌نامه ارسال شد)' : ' (حساب موجود، به سایت اختصاص یافت)'}
            </li>
          ))}
        </ul>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Button buttonStyle="primary" el="anchor" newTab url={result.site.url}>
            مشاهدهٔ سایت
          </Button>
          <Button buttonStyle="secondary" el="link" to={result.site.adminUrl}>
            ویرایش تنظیمات سایت
          </Button>
          <Button
            buttonStyle="secondary"
            onClick={() => {
              setResult(null)
              setName('')
              setDomain('')
              setType('business')
              setLocales(['fa'])
              setDefaultLocale('fa')
              setUsers([{ email: '', role: 'owner' }])
            }}
          >
            ساخت سایت دیگر
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '40rem' }}>
      {message && (
        <div className="banner banner--error">{message}</div>
      )}

      <TextInput
        Error={errors.name ? <FieldError message={errors.name} /> : undefined}
        label="نام سایت"
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
        path="name"
        required
        showError={Boolean(errors.name)}
        value={name}
      />

      <TextInput
        description="میزبان کامل بدون پروتکل — مثلاً client.ir"
        Error={errors.domain ? <FieldError message={errors.domain} /> : undefined}
        label="دامنه"
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDomain(event.target.value)}
        path="domain"
        required
        rtl={false}
        showError={Boolean(errors.domain)}
        value={domain}
      />

      <SelectInput
        Error={errors.type ? <FieldError message={errors.type} /> : undefined}
        label="نوع سایت"
        name="type"
        onChange={(option) => setType(String((option as Option).value))}
        options={TYPE_OPTIONS}
        path="type"
        required
        showError={Boolean(errors.type)}
        value={type}
      />

      <SelectInput
        Error={errors.locales ? <FieldError message={errors.locales} /> : undefined}
        hasMany
        isClearable={false}
        label="زبان‌های سایت"
        name="locales"
        onChange={(option) => changeLocales((Array.isArray(option) ? option : [option]).map(({ value }) => String(value)))}
        options={LOCALE_OPTIONS}
        path="locales"
        required
        showError={Boolean(errors.locales)}
        value={locales}
      />

      <SelectInput
        description="زبان پیش‌فرض بدون پیشوند در نشانی‌ها می‌آید."
        Error={errors.defaultLocale ? <FieldError message={errors.defaultLocale} /> : undefined}
        label="زبان پیش‌فرض"
        name="defaultLocale"
        onChange={(option) => setDefaultLocale(String((option as Option).value))}
        options={LOCALE_OPTIONS.filter(({ value }) => locales.includes(value))}
        path="defaultLocale"
        required
        showError={Boolean(errors.defaultLocale)}
        value={defaultLocale}
      />

      <fieldset style={{ border: 'none', display: 'flex', flexDirection: 'column', gap: '0.75rem', margin: 0, padding: 0 }}>
        <legend>دعوت کاربران مشتری</legend>

        {users.map((user, index) => (
          <div key={index} style={rowStyle}>
            <div style={{ flex: 1 }}>
              <TextInput
                Error={
                  errors[`users.${index}.email`] ? (
                    <FieldError message={errors[`users.${index}.email`] ?? ''} />
                  ) : undefined
                }
                label="رایانامه"
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setUsers(users.map((row, i) => (i === index ? { ...row, email: event.target.value } : row)))
                }
                path={`users-${index}-email`}
                rtl={false}
                showError={Boolean(errors[`users.${index}.email`])}
                value={user.email}
              />
            </div>

            <div style={{ width: '16rem' }}>
              <SelectInput
                label="نقش"
                name={`users-${index}-role`}
                onChange={(option) =>
                  setUsers(
                    users.map((row, i) =>
                      i === index ? { ...row, role: String((option as Option).value) as InviteUser['role'] } : row,
                    ),
                  )
                }
                options={ROLE_OPTIONS}
                path={`users-${index}-role`}
                value={user.role}
              />
            </div>

            <Button
              buttonStyle="icon-label"
              icon="x"
              onClick={() => setUsers(users.filter((_, i) => i !== index))}
              type="button"
            />
          </div>
        ))}

        <Button
          buttonStyle="secondary"
          icon="plus"
          onClick={() => setUsers([...users, { email: '', role: 'editor' }])}
          type="button"
        >
          افزودن کاربر
        </Button>
      </fieldset>

      <div style={{ marginTop: '1rem' }}>
        <Button buttonStyle="primary" disabled={pending} type="submit">
          {pending ? 'در حال ساخت…' : 'ساخت سایت'}
        </Button>
      </div>
    </form>
  )
}
