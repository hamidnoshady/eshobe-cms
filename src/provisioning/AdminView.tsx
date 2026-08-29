import React from 'react'

import type { AdminViewServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'

import { ProvisionSiteForm } from './AdminForm'

/**
 * The "New site" action's home (Wave 5): `/admin/collections/sites/provision`.
 *
 * Registered as a custom view on the `sites` collection, so it lives one click
 * from the sites list and inherits the admin shell. The form posts to
 * `/api/provision-site`; the endpoint and `provisionSite` both re-check the
 * role, so this gate is UX, not the security boundary.
 */
export const ProvisionSiteView: React.FC<AdminViewServerProps> = ({ initPageResult }) => {
  const user = initPageResult.req.user

  if (!isPlatformAdmin(user)) {
    return (
      <div className="banner banner--error">
        ساخت سایت جدید فقط برای مدیر پلتفرم ممکن است. برای دعوت یا ویرایش کاربران با پشتیبانی تماس بگیرید.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '44rem' }}>
      <h1>ساخت سایت جدید</h1>

      <p>
        یک اقدام، نه یک فهرست: با ثبت نام، دامنه، نوع و زبان‌های سایت، همه‌چیز در یک مرحله ساخته می‌شود — برگه‌های
        اولیه، سربرگ و پابرگ، پوستهٔ متناسب با نوع سایت، محتوای هر زبان و دعوت‌نامهٔ کاربران مشتری با نقش دلخواه.
      </p>

      <ProvisionSiteForm />
    </div>
  )
}

export default ProvisionSiteView
