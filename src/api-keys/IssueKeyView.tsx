import React from 'react'

import type { AdminViewServerProps } from 'payload'

import { isPlatformAdmin } from '@/access/platformAdmin'

import { IssueKeyForm } from './IssueKeyForm'

/**
 * The issuing surface for platform staff: `/admin/collections/api-keys/issue`.
 *
 * Why a custom view and not the collection's own create form: a Payload create
 * redirects to the freshly created document, which is fetched *again* from the
 * database — and the raw key exists only in the minting request, never at rest
 * (`keyHash` is a sha256). Any key "created" through the standard form was therefore
 * a credential nobody could ever read back, which is the trap this view replaces.
 * The form posts to `POST /api/api-keys/issue` and shows the raw value exactly once,
 * with a copy button; the endpoint re-checks the role, so this gate is UX, not the
 * security boundary.
 */
export const IssueKeyView: React.FC<AdminViewServerProps> = ({ initPageResult }) => {
  const user = initPageResult.req.user

  if (!isPlatformAdmin(user)) {
    return (
      <div className="banner banner--type-error">
        صدور کلید فقط برای مدیر پلتفرم ممکن است. برای صدور کلید با پشتیبانی تماس بگیرید.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '44rem' }}>
      <h1>صدور کلید جدید</h1>

      <p>
        کلید کامل فقط یک بار، در همین صفحه و در لحظهٔ صدور، نمایش داده می‌شود — CMS فقط هش آن را نگه
        می‌دارد و نمایش مجدد آن ممکن نیست. آن را همین حالا در برنامهٔ مقصد (مثلاً سامانهٔ صندوق فروش)
        ذخیره کنید.
      </p>

      <IssueKeyForm />
    </div>
  )
}

export default IssueKeyView
