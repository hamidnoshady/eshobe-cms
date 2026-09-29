'use client'

import React, { useEffect, useState } from 'react'

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
    <section style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <h2 style={{ margin: 0 }}>داده نمونه</h2>
      <p style={{ color: 'var(--theme-elevation-600)', margin: 0 }}>
        محتوای آماده (دسته‌ها، نوشته‌ها و تصویر) برای اینکه پیش‌نمایش پوسته خالی نباشد. فقط موارد
        موجود‌نبوده اضافه می‌شود؛ چیزی تغییر یا حذف نمی‌شود.
      </p>
      {packs.length === 0 ? (
        <div className="banner banner--type-default">برای این نوع سایت بستهٔ نمونه‌ای وجود ندارد.</div>
      ) : (
        <>
          <select onChange={(e) => setKey(e.target.value)} style={{ maxWidth: '24rem' }} value={key}>
            {packs.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name.fa ?? p.key}
              </option>
            ))}
          </select>
          {selected?.description.fa && <p style={{ margin: 0 }}>{selected.description.fa}</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <ActionButton body={{ dryRun: true, pack: key }} disabled={!key} label="پیش‌نمایش تغییرات" url={url} />
            <ActionButton
              body={{ pack: key }}
              confirm="داده نمونه به این سایت اضافه می‌شود. ادامه می‌دهید؟"
              disabled={!key}
              label="افزودن داده نمونه"
              style="primary"
              url={url}
            />
          </div>
        </>
      )}
    </section>
  )
}

export default DemoPackPanel
