import React from 'react'

import type { DocumentViewServerProps } from 'payload'

import { siteStaffRole, themeSettingsView } from '@/deploy/tenantSettings'

import { ThemeSettingsForm } from './ThemeSettingsForm'

/**
 * The «تنظیمات پوسته» document view on a site: `/admin/collections/sites/:id/theme-settings`.
 *
 * The customer's half of a deployable theme. Which theme runs is the operator's
 * decision (the «استقرار پوسته» tab, platform staff only); what goes into the boxes
 * the theme asked the *customer* to fill in is theirs. This view renders exactly
 * those boxes, generated from the synced manifest of the theme the site actually
 * runs — never a raw collection form, never another site's values, never a secret.
 *
 * The membership check here is UX; `POST /api/site-theme-settings/current` repeats it
 * and is the boundary.
 */
export const ThemeSettingsView: React.FC<DocumentViewServerProps> = async ({ doc, initPageResult }) => {
  const req = initPageResult?.req
  const site = (doc ?? {}) as Record<string, unknown>
  const siteId = site.id ? String(site.id) : ''

  if (!req || !siteId) {
    return (
      <div className="banner banner--type-default" style={{ margin: '2rem' }}>
        ابتدا سایت را ذخیره کنید.
      </div>
    )
  }

  const role = siteStaffRole(req.user, siteId)
  if (!role) {
    return (
      <div className="banner banner--type-error" style={{ margin: '2rem' }}>
        به تنظیمات پوستهٔ این سایت دسترسی ندارید.
      </div>
    )
  }

  const view = await themeSettingsView(req, siteId, role)

  return (
    <div style={{ padding: '2rem' }}>
      <ThemeSettingsForm initial={view} siteId={siteId} siteName={String(site.name ?? '')} />
    </div>
  )
}

export default ThemeSettingsView
