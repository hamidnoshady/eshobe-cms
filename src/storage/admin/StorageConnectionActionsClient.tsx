'use client'

import React, { useState } from 'react'

import { useRouter } from 'next/navigation'

import { Button } from '@payloadcms/ui/elements/Button'

import { StorageTestModal } from './StorageTestModal.client'

export const StorageConnectionActionsClient: React.FC<{ connectionId: string }> = ({ connectionId }) => {
  const router = useRouter()
  const [mode, setMode] = useState<'full' | 'quick' | null>(null)

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <Button buttonStyle="secondary" onClick={() => setMode('quick')} type="button">
          آزمون سریع
        </Button>
        <Button buttonStyle="primary" onClick={() => setMode('full')} type="button">
          خودآزمایی کامل
        </Button>
      </div>

      <StorageTestModal
        connectionId={connectionId}
        mode={mode ?? 'full'}
        onClose={() => {
          setMode(null)
          router.refresh()
        }}
        open={mode !== null}
      />
    </>
  )
}

export default StorageConnectionActionsClient
