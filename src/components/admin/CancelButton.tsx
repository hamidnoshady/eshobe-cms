'use client'

import React from 'react'
import { useRouter } from 'next/navigation'
import { Button, useFormModified, useTranslation } from '@payloadcms/ui'

export const CancelButton: React.FC = () => {
  const router = useRouter()
  const { t } = useTranslation()
  const modified = useFormModified()

  const handleCancel = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (modified) {
      const confirmMessage =
        t('general:unsavedChanges') ||
        'تغییرات ذخیره نشده‌ای دارید. قبل از ادامه، آن‌ها را ذخیره یا لغو کنید.'
      if (typeof window !== 'undefined' && !window.confirm(confirmMessage)) {
        return
      }
    }

    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    } else {
      router.push('/admin')
    }
  }

  return (
    <Button
      buttonStyle="secondary"
      className="action-cancel-btn"
      id="action-cancel"
      onClick={handleCancel}
      size="medium"
      type="button"
    >
      {t('general:cancel') || 'انصراف'}
    </Button>
  )
}

export default CancelButton
