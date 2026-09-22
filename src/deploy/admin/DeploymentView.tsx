import React from 'react'

import type { DocumentViewServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'

import { DeploymentPanel } from './DeploymentPanel'

/**
 * The "استقرار پوسته" document view on a site:
 * `/admin/collections/sites/:id/deployment`.
 *
 * A server component that resolves the site and hands the client panel only what it
 * needs. Two reasons it is not a client component fetching the site itself:
 *
 *  - the panel's mode gating depends on `domainVerified` and `type`, and reading them
 *    here means the form cannot be rendered in a state the server would reject;
 *  - the customer check happens before any of it is sent.
 *
 * That check is UX, not the boundary — every `/api/platform/*` route this view calls
 * re-checks `requireOperator` itself. A customer's owner who guesses the URL sees a
 * refusal instead of a console, and would get a 403 from each button regardless.
 */
export const DeploymentView: React.FC<DocumentViewServerProps> = ({ doc, initPageResult }) => {
  const user = initPageResult?.req?.user

  if (!isPlatformAdmin(user)) {
    return (
      <div className="banner banner--type-error">
        استقرار پوسته فقط توسط کارکنان سکو انجام می‌شود. برای تغییر پوستهٔ سایت با پشتیبانی تماس
        بگیرید.
      </div>
    )
  }

  const site = (doc ?? {}) as Record<string, unknown>
  const siteId = site.id ? String(site.id) : ''

  if (!siteId) {
    return (
      <div className="banner banner--type-default">
        ابتدا سایت را ذخیره کنید، سپس می‌توانید برای آن پوسته مستقر کنید.
      </div>
    )
  }

  return (
    <div style={{ padding: '2rem' }}>
      <DeploymentPanel
        domainVerified={site.domainVerified === true}
        siteDomain={String(site.domain ?? '')}
        siteId={siteId}
        siteName={String(site.name ?? '')}
        siteType={String(site.type ?? 'business')}
      />
    </div>
  )
}

export default DeploymentView
