'use client'

import React, { useEffect, useState } from 'react'

import { useFormFields } from '@payloadcms/ui'

import type { ThemeSettingsView } from '@/deploy/tenantSettings'
import { idOf } from '@/lib/ids'

import { ThemeSettingsForm } from './ThemeSettingsForm'

/**
 * The deployed theme's own design options inside «طراحی سایت» — a `ui` field on the
 * `theme` document, so typography, layout and motion sit beside the colour tokens
 * instead of on a tab of the site settings that nobody finds.
 *
 * Reads the same `GET /api/site-theme-settings/current` the «تنظیمات پوسته» page uses
 * and shows only the manifest's `group: "design"` settings. The site comes from the
 * document's own tenant field; the endpoint re-checks membership. Renders nothing for
 * a site without a deployable theme or a theme with no design settings.
 */
export const ThemeDesignSettingsField: React.FC = () => {
  const siteValue = useFormFields(([fields]) => fields.site?.value)
  const siteId = idOf(siteValue) ?? ''
  const [view, setView] = useState<null | ThemeSettingsView>(null)

  useEffect(() => {
    if (!siteId) return
    const controller = new AbortController()
    fetch(`/api/site-theme-settings/current?site=${encodeURIComponent(siteId)}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then(async (response) => (response.ok ? ((await response.json()) as ThemeSettingsView) : null))
      .then((next) => setView(next))
      .catch(() => undefined)
    return () => controller.abort()
  }, [siteId])

  if (!siteId || !view) return null

  return (
    <div style={{ marginBlockStart: 'var(--base)' }}>
      <ThemeSettingsForm
        embedded
        group="design"
        initial={view}
        key={siteId}
        siteId={siteId}
        siteLocales={[]}
        siteName=""
      />
    </div>
  )
}

export default ThemeDesignSettingsField
