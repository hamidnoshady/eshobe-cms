'use client'

import { Button } from '@/components/ui/button'
import { MAX_ORDER_QUANTITY } from '@/lib/checkout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { uiString } from '@/lib/ui-strings'
import React, { useState } from 'react'

type Status = 'error' | 'idle' | 'sending'

/**
 * One card's worth of checkout: a name, a phone number, a quantity, one product.
 *
 * No cart, no account, no client-side price. The buyer sends *what they want*; the
 * server decides what it costs, which site it belongs to and whether the stock is
 * still there (`src/endpoints/checkout.ts`). A form that computed a total would be a
 * form that lies, and worse: one whose numbers an attacker controls.
 *
 * The URL is relative on purpose — the request has to go to whatever domain the
 * buyer is standing on, since that header is how the tenant is resolved. An absolute
 * admin origin would send every store's orders to the control plane's database.
 */
export const PurchaseForm: React.FC<{
  /** `null` when the store does not count stock; `0` is handled by the caller. */
  availability: null | number
  locale: string
  productId: string
}> = ({ availability, locale, productId }) => {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)

  const max = Math.max(1, Math.min(MAX_ORDER_QUANTITY, availability ?? MAX_ORDER_QUANTITY))
  const id = `purchase-${productId}`

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const form = new FormData(event.currentTarget)
    const body = {
      // The honeypot the endpoint expects; a human never sees it, a bot always fills it.
      company: String(form.get('company') ?? ''),
      email: String(form.get('email') ?? '').trim() || undefined,
      name: String(form.get('name') ?? '').trim(),
      note: String(form.get('note') ?? '').trim() || undefined,
      phone: String(form.get('phone') ?? '').trim(),
      product: productId,
      quantity: Number(form.get('quantity') ?? 1),
    }

    setStatus('sending')
    setError(null)

    try {
      const response = await fetch('/api/checkout', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })

      const result = (await response.json()) as {
        confirmationUrl?: string
        message?: string
        ok?: boolean
        redirectUrl?: null | string
      }

      if (!response.ok && !result.confirmationUrl) {
        setStatus('error')
        setError(result.message || 'خرید انجام نشد. لطفاً دوباره تلاش کنید.')

        return
      }

      // A gateway's own URL first (https://payment.example/…); otherwise the store's
      // confirmation page. A 503 with a `confirmationUrl` still goes there: the order
      // exists and the buyer has to be told what to do next.
      const target = result.redirectUrl || result.confirmationUrl

      if (!target) {
        setStatus('error')
        setError('خرید ثبت شد، اما نشانی تأیید بازنگشت. سفارش خود را از فروشگاه بپرسید.')

        return
      }

      window.location.assign(target)
    } catch {
      setStatus('error')
      setError('ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.')
    }
  }

  return (
    <form className="mt-2 space-y-3 border-t border-border pt-4" onSubmit={submit}>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-name`}>{uiString('name', locale)}</Label>
          <Input autoComplete="name" id={`${id}-name`} name="name" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-phone`}>{uiString('phone', locale)}</Label>
          <Input dir="ltr" id={`${id}-phone`} inputMode="tel" name="phone" required />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-quantity`}>{uiString('quantity', locale)}</Label>
          <Input defaultValue={1} id={`${id}-quantity`} max={max} min={1} name="quantity" type="number" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-email`}>{uiString('email', locale)}</Label>
          <Input dir="ltr" id={`${id}-email`} inputMode="email" name="email" type="email" />
        </div>
      </div>

      {/* The honeypot: present for a bot that parses the form, `display:none` for a
          human who never sees it — and still submitted, so a filler is detectable. */}
      <input
        aria-hidden
        autoComplete="off"
        className="hidden"
        name="company"
        tabIndex={-1}
        type="text"
      />

      <Button className="w-full" disabled={status === 'sending'} type="submit">
        {status === 'sending' ? uiString('submitting', locale) : uiString('buyNow', locale)}
      </Button>

      {error && (
        <p aria-live="polite" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
