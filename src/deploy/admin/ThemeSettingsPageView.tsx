import React from 'react'

import { Gutter } from '@payloadcms/ui'

import type { AdminViewServerProps } from 'payload'

import { siteStaffRole, themeSettingsView } from '@/deploy/tenantSettings'
import { customerSiteSummary } from '@/lib/customerSiteSummary'

import { ThemeSettingsForm } from './ThemeSettingsForm'

/**
 * «تنظیمات پوسته» as a top-level admin route, `/admin/theme-settings`, listed in the
 * customer sidebar. The theme's non-design options (map, coordinates, deployment
 * variables, content mapping) live here; its look-and-feel options are in «طراحی سایت».
 *
 * The site is the caller's own, resolved tenant-scoped (`customerSiteSummary`) — never
 * from a parameter. Membership is re-checked here and by the save endpoint.
 */
export const ThemeSettingsPageView: React.FC<AdminViewServerProps> = async ({ initPageResult }) => {
  const req = initPageResult.req
  const site = (await customerSiteSummary(req, [])).site
  const siteId = site?.id ? String(site.id) : ''
  const role = siteId ? siteStaffRole(req.user, siteId) : null

  if (!site || !role) {
    return (
      <div className="banner banner--type-error" style={{ margin: '2rem' }}>
        به تنظیمات پوستهٔ این سایت دسترسی ندارید.
      </div>
    )
  }

  const view = await themeSettingsView(req, siteId, role)

  return (
    <Gutter>
      <ThemeSettingsForm
        group="general"
        initial={view}
        siteId={siteId}
        siteLocales={(Array.isArray(site.availableLocales) ? site.availableLocales : ['fa']).map(String)}
        siteName={String(site.name ?? '')}
      />
    </Gutter>
  )
}

export default ThemeSettingsPageView
