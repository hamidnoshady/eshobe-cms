import React from 'react'

import { Gutter } from '@payloadcms/ui'
import type { AdminViewServerProps } from 'payload'

import { siteStaffRole } from '@/deploy/tenantSettings'
import { customerSiteSummary } from '@/lib/customerSiteSummary'
import { migrationCenterView } from '@/lib/migration/center'

import { MigrationCenterForm } from './MigrationCenterForm'

/**
 * «مرکز مهاجرت» as a top-level admin route (`/admin/migration-center`).
 *
 * The site is the caller's own, resolved tenant-scoped — never from a
 * parameter — and membership is re-checked here and again by every endpoint
 * the form calls. Rendering nothing useful for a non-member is deliberate:
 * a migration screen names a customer's old domain, job state and blockers.
 */
export const MigrationCenterPageView: React.FC<AdminViewServerProps> = async ({
  initPageResult,
}) => {
  const req = initPageResult.req
  const site = (await customerSiteSummary(req, [])).site
  const siteId = site?.id ? String(site.id) : ''
  const role = siteId ? siteStaffRole(req.user, siteId) : null

  if (!site || !role) {
    return (
      <div className="banner banner--type-error" style={{ margin: '2rem' }}>
        به مرکز مهاجرت این سایت دسترسی ندارید.
      </div>
    )
  }

  const initial = await migrationCenterView(req, siteId, role)

  return (
    <Gutter>
      <MigrationCenterForm
        initial={initial}
        siteId={siteId}
        siteName={String(site.name ?? '')}
      />
    </Gutter>
  )
}

export default MigrationCenterPageView
