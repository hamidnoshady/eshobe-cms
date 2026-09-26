'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'

type Step = { detail?: string; key: string; label: string; ok: boolean }

type Props = {
  connectionId: string
  mode: 'full' | 'quick'
  onClose: () => void
  open: boolean
}

export const StorageTestModal: React.FC<Props> = ({ connectionId, mode, onClose, open }) => {
  const [pending, setPending] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [ok, setOk] = useState<boolean | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  const run = useCallback(async () => {
    setPending(true)
    setSteps([])
    setMessage(null)
    setLatencyMs(null)
    setOk(null)

    try {
      const response = await fetch('/api/storage-connections/self-test', {
        body: JSON.stringify({ id: connectionId, mode }),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      const payload = (await response.json()) as {
        latencyMs?: number
        message?: string
        ok?: boolean
        steps?: Step[]
      }

      setSteps(Array.isArray(payload.steps) ? payload.steps : [])
      setLatencyMs(typeof payload.latencyMs === 'number' ? payload.latencyMs : null)
      setMessage(typeof payload.message === 'string' ? payload.message : null)
      setOk(Boolean(payload.ok))
    } catch {
      setOk(false)
      setMessage('ارتباط با سرور برقرار نشد.')
    } finally {
      setPending(false)
    }
  }, [connectionId, mode])

  return (
    <dialog
      aria-labelledby="storage-test-title"
      aria-modal="true"
      ref={dialogRef}
      style={{ border: 'none', borderRadius: '8px', maxWidth: '32rem', padding: '1.5rem', width: 'min(100vw - 2rem, 32rem)' }}
      onClose={onClose}
    >
      <h2 id="storage-test-title" style={{ marginTop: 0 }}>
        {mode === 'full' ? 'خودآزمایی کامل ذخیره‌سازی' : 'آزمون سریع اتصال'}
      </h2>

      {!pending && steps.length === 0 && ok === null && (
        <p>برای شروع آزمون، دکمهٔ «شروع» را بزنید.</p>
      )}

      {pending && <p role="status">در حال آزمون…</p>}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {steps.map((step) => (
          <li key={step.key} style={{ marginBottom: '0.35rem' }}>
            <span aria-hidden="true">{step.ok ? '✓' : '✕'}</span> {step.label}
            {step.detail ? <span style={{ color: 'var(--theme-elevation-600)' }}> — {step.detail}</span> : null}
          </li>
        ))}
      </ul>

      {latencyMs !== null && <p>تأخیر: {latencyMs} ms</p>}

      {message && (
        <div className={`banner banner--type-${ok ? 'success' : 'error'}`} role="alert">
          {message}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
        <Button buttonStyle="secondary" disabled={pending} onClick={run} type="button">
          {steps.length === 0 ? 'شروع' : 'تکرار'}
        </Button>
        <Button buttonStyle="primary" disabled={pending} onClick={onClose} type="button">
          بستن
        </Button>
      </div>
    </dialog>
  )
}

export default StorageTestModal
