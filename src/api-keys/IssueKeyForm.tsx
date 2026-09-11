'use client'

import React, { useEffect, useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'
import { SelectInput } from '@payloadcms/ui/fields/Select'
import { TextInput } from '@payloadcms/ui/fields/Text'

/** `@payloadcms/ui` option shape — `{ label, value }`. */
type Option = { label: string; value: string }

type Role = 'platform' | 'site'

const ROLE_OPTIONS: Option[] = [
  { label: 'سایت — خواندن/نوشتن یک سایت', value: 'site' },
  { label: 'پلتفرم — فقط ساخت سایت و مدیریت کلیدها', value: 'platform' },
]

/** The one shape `/api/api-keys/issue` answers with on 201. */
type IssuedKey = {
  id: string
  key: string
  name: string
  prefix: string
  role: Role
}

type FieldErrors = Record<string, string>

/** Payload's own field-error markup, so server errors look native next to inputs. */
const FieldError = ({ message }: { message: string }) => (
  <div className="field-error">
    <span>{message}</span>
  </div>
)

/**
 * The issuing form: name, role and (for a site key) the site, posted to
 * `/api/api-keys/issue`. The response carries the raw key — the only moment it
 * exists outside the minting request — so the success state is not a redirect but
 * the key itself, in a copyable box, with the warning that it is never shown again.
 *
 * Plain React state, not Payload's form machinery: like the sites collection's
 * provision form, this form belongs to no collection document. `SelectInput` needs
 * the site list this admin can see, so it is fetched once on mount — the session
 * cookie is the credential, same as every other admin request.
 */
export const IssueKeyForm: React.FC = () => {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('site')
  const [siteId, setSiteId] = useState('')
  const [sites, setSites] = useState<Option[]>([])

  const [pending, setPending] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedKey | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true

    const load = async () => {
      try {
        const response = await fetch('/api/sites?depth=0&limit=200&sort=name', {
          credentials: 'same-origin',
          headers: { 'Accept-Language': 'fa' },
        })
        const json = (await response.json()) as { docs?: { domain: string; id: string; name: string }[] }

        if (!alive) return
        if (!response.ok) throw new Error('sites request failed')

        setSites(
          (json.docs ?? []).map((site) => ({
            label: `${site.name} (${site.domain})`,
            value: site.id,
          })),
        )
      } catch {
        if (alive) setMessage('فهرست سایت‌ها بارگذاری نشد. صفحه را دوباره باز کنید.')
      }
    }

    void load()

    return () => {
      alive = false
    }
  }, [])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const nextErrors: FieldErrors = {}
    if (!name.trim()) nextErrors.name = 'نام کلید الزامی است.'
    if (role === 'site' && !siteId) nextErrors.siteId = 'کلید «سایت» باید به یک سایت وصل باشد.'

    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }

    setPending(true)
    setErrors({})
    setMessage(null)

    try {
      const response = await fetch('/api/api-keys/issue', {
        body: JSON.stringify({ name: name.trim(), role, siteId: role === 'site' ? siteId : undefined }),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const json = await response.json()

      if (!response.ok) {
        setErrors({})
        setMessage(json.message ?? 'صدور کلید ناموفق بود.')
        return
      }

      setCopied(false)
      setIssued(json as IssuedKey)
    } catch {
      setMessage('ارتباط با سرور برقرار نشد.')
    } finally {
      setPending(false)
    }
  }

  /** Clipboard API first, textarea fallback for non-secure contexts. */
  const copyKey = async () => {
    if (!issued) return

    try {
      await navigator.clipboard.writeText(issued.key)
    } catch {
      const input = document.createElement('textarea')
      input.dir = 'ltr'
      input.value = issued.key
      document.body.append(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }

    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  if (issued) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem' }}>
        <div className="banner banner--type-success">
          کلید «{issued.name}» صادر شد.
          {issued.role === 'site' ? ' (کلید سایت)' : ' (کلید پلتفرم)'}
        </div>

        <div className="banner banner--type-default">
          این کلید فقط همین یک بار نمایش داده می‌شود — CMS فقط هش آن را نگه می‌دارد و نمایش مجدد آن
          ممکن نیست. آن را همین حالا در برنامهٔ مقصد ذخیره کنید.
        </div>

        <div
          style={{
            backgroundColor: 'var(--theme-elevation-100)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            padding: '1rem',
          }}
        >
          <code
            dir="ltr"
            style={{
              fontSize: '1rem',
              overflowWrap: 'anywhere',
              userSelect: 'all',
              wordBreak: 'break-all',
            }}
          >
            {issued.key}
          </code>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <Button buttonStyle="primary" onClick={copyKey} type="button">
              {copied ? 'کپی شد ✓' : 'کپی کلید'}
            </Button>
            <Button
              buttonStyle="secondary"
              onClick={() => {
                setIssued(null)
                setCopied(false)
                setName('')
                setRole('site')
                setSiteId('')
              }}
              type="button"
            >
              صدور کلید دیگر
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '40rem' }}>
      {message && <div className="banner banner--type-error">{message}</div>}

      <TextInput
        description="برای خودتان — مثلاً «سامانهٔ صندوق فروش، شعبهٔ مرکزی»."
        Error={errors.name ? <FieldError message={errors.name} /> : undefined}
        label="نام کلید"
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
        path="name"
        required
        showError={Boolean(errors.name)}
        value={name}
      />

      <SelectInput
        description="کلید «سایت» فقط به همان سایت دسترسی دارد. کلید «پلتفرم» هیچ محتوایی نمی‌خواند؛ فقط می‌تواند سایت بسازد یا کلید صادر/باطل کند."
        label="نوع کلید"
        name="role"
        onChange={(option) => setRole(String((option as Option).value) as Role)}
        options={ROLE_OPTIONS}
        path="role"
        required
        value={role}
      />

      {role === 'site' && (
        <SelectInput
          description="این کلید فقط به محتوای همین سایت دسترسی خواهد داشت."
          Error={errors.siteId ? <FieldError message={errors.siteId} /> : undefined}
          label="سایت"
          name="siteId"
          onChange={(option) => setSiteId(String((option as Option).value))}
          options={sites}
          path="siteId"
          required
          showError={Boolean(errors.siteId)}
          value={siteId}
        />
      )}

      <div style={{ marginTop: '1rem' }}>
        <Button
          buttonStyle="primary"
          disabled={pending || (role === 'site' && sites.length === 0)}
          type="submit"
        >
          {pending ? 'در حال صدور…' : 'صدور کلید'}
        </Button>
      </div>
    </form>
  )
}
