'use client'

import React, { useEffect, useState } from 'react'

import { Banner, SelectInput } from '@payloadcms/ui'

import { ActionButton } from './ActionButton'

type Pack = { description: Record<string, string>; key: string; name: Record<string, string>; siteType: string }

/**
 * «داده نمونه»: pick a demo pack, preview what it would add, import it.
 * The server refuses a pack of another site type and only ever fills gaps, so the
 * list here is a convenience filter, not the safeguard.
 */
export const DemoPackPanel: React.FC<{ siteId: string; siteType: string }> = ({ siteId, siteType }) => {
  const [packs, setPacks] = useState<Pack[]>([])
  const [key, setKey] = useState('')

  useEffect(() => {
    fetch('/api/platform/demo-packs', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { packs: [] }))
      .then((d: { packs?: Pack[] }) => {
        const mine = (d.packs ?? []).filter((p) => p.siteType === siteType)
        setPacks(mine)
        setKey((k) => k || mine[0]?.key || '')
      })
      .catch(() => setPacks([]))
  }, [siteType])

  const selected = packs.find((p) => p.key === key)
  const url = `/api/platform/sites/${siteId}/demo-pack`

  return (
    <section className="theme-card">
      <div className="theme-card__head">
        <h2 className="theme-card__title">داده نمونه</h2>
      </div>
      <p className="theme-console__muted">
        محتوای آماده (صفحه‌ها، دسته‌ها، نوشته‌ها و تصویر) تا پیش‌نمایش پوسته خالی نباشد. فقط
        آنچه وجود ندارد اضافه می‌شود؛ چیزی تغییر یا حذف نمی‌شود و اجرای دوباره چیزی اضافه نمی‌کند.
      </p>
      {packs.length === 0 ? (
        <Banner type="info">برای این نوع سایت بستهٔ نمونه‌ای وجود ندارد.</Banner>
      ) : (
        <>
          <SelectInput
            description={selected?.description.fa}
            label="بستهٔ نمونه"
            name="demo-pack"
            onChange={(option) =>
              setKey(String((option as { value?: string } | null)?.value ?? ''))
            }
            options={packs.map((p) => ({ label: p.name.fa ?? p.key, value: p.key }))}
            path="demo-pack"
            value={key}
          />
          <div className="theme-actions">
            <ActionButton
              body={{ pack: key }}
              confirm="داده نمونه به این سایت اضافه می‌شود. ادامه می‌دهید؟"
              disabled={!key}
              label="افزودن داده نمونه"
              style="primary"
              url={url}
            />
            <ActionButton body={{ dryRun: true, pack: key }} disabled={!key} label="فقط نشان بده چه اضافه می‌شود" url={url} />
          </div>
        </>
      )}
    </section>
  )
}

export default DemoPackPanel
