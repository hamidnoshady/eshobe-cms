'use client'

import React, { useEffect } from 'react'
import { Button, useForm, useFormModified, useFormProcessing, useTranslation } from '@payloadcms/ui'

export const AccountSaveButton: React.FC<{ label?: string }> = ({ label: labelProp }) => {
  const { t } = useTranslation()
  const { submit } = useForm()
  const modified = useFormModified()
  const processing = useFormProcessing()
  const label = labelProp || t('general:save') || 'ذخیره'
  const savingLabel = t('general:saving') || 'در حال ذخیره…'

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        if (!processing) {
          void submit()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [processing, submit])

  const handleSubmit = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (processing) return
    await submit()
  }

  return (
    <Button
      buttonStyle="primary"
      className={`action-save-btn ${!modified ? 'action-save-btn--unmodified' : ''}`}
      disabled={processing}
      id="action-save"
      onClick={handleSubmit}
      size="medium"
      type="button"
    >
      {processing ? savingLabel : label}
    </Button>
  )
}

export default AccountSaveButton
