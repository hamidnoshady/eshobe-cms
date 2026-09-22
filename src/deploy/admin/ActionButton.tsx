'use client'

import React, { useState } from 'react'

import { Button } from '@payloadcms/ui/elements/Button'
import { useRouter } from 'next/navigation'

/**
 * The one button behind every operator action on this surface: sync, publish,
 * self-test, deploy, poll, stop, roll back, revert.
 *
 * They are all the same interaction — POST to a `/api/platform/*` route, show what it
 * said, refresh the document — and the two things that matter are the two that are
 * easy to skip in a hand-rolled button:
 *
 *  - **`pending` disables the button.** Every one of these actions is expensive and
 *    not idempotent in the way a reader expects: a double-clicked "deploy" is two
 *    Coolify applications, and the second one wins the domain. One in-flight request
 *    at a time, enforced here rather than remembered at each call site.
 *  - **The server's own message is what gets displayed.** These endpoints answer in
 *    Persian and say precisely which precondition failed — "this theme is not
 *    published", "the domain is not verified", "this theme does not proxy /api". A
 *    generic "action failed" would throw away the only text that tells the operator
 *    what to do next.
 *
 * `confirm` is opt-in because some of these are destructive: stopping a live
 * deployment takes a customer's storefront back to the built-in renderer, and that
 * should cost one deliberate click more than refreshing a build log.
 */
export type ActionButtonProps = {
  /** Body to POST. Omitted entirely when absent — some routes take none. */
  body?: Record<string, unknown>
  /** When set, the operator must accept this sentence before the request is sent. */
  confirm?: string
  disabled?: boolean
  label: string
  /** Shown on 2xx. The server's `message` wins when it sends one. */
  successMessage?: string
  style?: 'danger' | 'none' | 'primary' | 'secondary'
  /** A `/api/...` path. Relative by design: the browser is not the sandbox. */
  url: string
}

type Result = { ok: boolean; text: string }

export const ActionButton: React.FC<ActionButtonProps> = ({
  body,
  confirm,
  disabled,
  label,
  style = 'secondary',
  successMessage,
  url,
}) => {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<null | Result>(null)

  const run = async () => {
    if (confirm && !window.confirm(confirm)) return

    setPending(true)
    setResult(null)

    try {
      const response = await fetch(url, {
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })

      /**
       * A non-JSON body here means something upstream answered instead of the
       * endpoint — a proxy timeout page, most likely. Reading it as text and saying
       * so beats `Unexpected token < in JSON`, which sends the operator looking for
       * a bug in the CMS.
       */
      let payload: Record<string, unknown> = {}
      try {
        payload = (await response.json()) as Record<string, unknown>
      } catch {
        setResult({
          ok: false,
          text: `پاسخ نامعتبر از سرور (وضعیت ${response.status}). دوباره تلاش کنید.`,
        })
        return
      }

      const serverMessage = typeof payload.message === 'string' ? payload.message : null

      if (!response.ok) {
        setResult({ ok: false, text: serverMessage ?? `عملیات ناموفق بود (${response.status}).` })
        return
      }

      setResult({ ok: true, text: serverMessage ?? successMessage ?? 'انجام شد.' })

      // The document this button sits on is now stale — a sync rewrote the manifest
      // fields, a deploy added a row. Re-fetch rather than patch local state.
      router.refresh()
    } catch {
      setResult({ ok: false, text: 'ارتباط با سرور برقرار نشد.' })
    } finally {
      setPending(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div>
        <Button
          buttonStyle={style === 'danger' ? 'error' : style}
          disabled={pending || disabled}
          onClick={run}
          type="button"
        >
          {pending ? 'در حال اجرا…' : label}
        </Button>
      </div>

      {result && (
        <div className={`banner banner--type-${result.ok ? 'success' : 'error'}`}>{result.text}</div>
      )}
    </div>
  )
}

export default ActionButton
