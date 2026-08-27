'use client'

import React from 'react'
import { DefaultEditView } from '@payloadcms/ui'
import { CancelButton } from './CancelButton'
import { AccountSaveButton } from './AccountSaveButton'

export const AccountView: React.FC<Parameters<typeof DefaultEditView>[0]> = (props) => {
  return (
    <DefaultEditView
      {...props}
      BeforeDocumentControls={<CancelButton />}
      SaveButton={<AccountSaveButton />}
    />
  )
}

export default AccountView
