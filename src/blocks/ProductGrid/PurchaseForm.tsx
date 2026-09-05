'use client'

import type { CurrencyCode } from '@/lib/money'
import type { PaymentMethodOption } from '@/lib/checkout'

import { Button } from '@/components/ui/button'
import { MAX_ORDER_QUANTITY } from '@/lib/checkout'
import { formatPrice } from '@/lib/format'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { uiString } from '@/lib/ui-strings'
import React, { useState } from 'react'
import { cn } from '@/utilities/ui'

type Status = 'error' | 'idle' | 'sending'

/**
 * One card's worth of checkout: a name, a phone number, a quantity, one product — and, when
 * the shop takes them, a choice of Iranian payment gateway.
 *
 * No cart, no account, no client-side price. The buyer sends *what they want*; the
 * server decides what it costs, which site it belongs to and whether the stock is
 * still there (`src/endpoints/checkout.ts`). A form that computed a total would be a
 * form that lies, and worse: one whose numbers an attacker controls.
 *
 * The URL is relative on purpose — the request has to go to whatever domain the
 * buyer is standing on, since that header is how the tenant is resolved. An absolute
 * admin origin would send every store's orders to the control plane's database.
 *
 * ## The gateway picker
 *
 * `paymentMethods` arrives from the server component (`paymentMethodsForSite`) already
 * filtered and ordered, and this form treats it as a *suggestion*, never as the truth:
 *
 * - The window shown beside a method is the site's, quoted without a quantity, because the
 *   buyer has not chosen one yet. The endpoint re-checks it against the real basket.
 * - A `409` that comes back with a fresh `methods` array replaces the picker. That is the
 *   honest way to handle "you picked one that this basket cannot use" — the server knows
 *   the amount, so the server sends the list, and this form renders it. Guessing on the
 *   client would mean multiplying a price by a quantity in the browser and trusting the
 *   answer, which is the one thing this form is written not to do.
 * - Posting a `gateway` the site does not have is refused server-side. The radio group is
 *   a convenience over an allowlist, not the allowlist.
 *
 * With no methods the form is exactly what it was before the module existed: no picker, no
 * `gateway` in the body, and the site's configured method (`store.paymentProvider`) decides
 * what happens next. A shop that never switches a gateway on never sees this code run.
 */
export const PurchaseForm: React.FC<{
  /** `null` when the store does not count stock; `0` is handled by the caller. */
  availability: null | number
  /** For the window beside each method. The buyer is never asked for a price. */
  currency?: CurrencyCode
  locale: string
  paymentMethods?: PaymentMethodOption[]
  productId: string
}> = ({ availability, currency = 'IRT', locale, paymentMethods = [], productId }) => {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  /**
   * State, not the prop: a refusal carries a newer list and the picker has to be able to
   * show it without a page reload. Seeded from the prop and never re-seeded from it, so a
   * server re-render cannot silently undo a buyer's choice.
   */
  const [methods, setMethods] = useState<PaymentMethodOption[]>(paymentMethods)
  const [selected, setSelected] = useState<null | string>(paymentMethods[0]?.id ?? null)

  const max = Math.max(1, Math.min(MAX_ORDER_QUANTITY, availability ?? MAX_ORDER_QUANTITY))
  const id = `purchase-${productId}`
  const chosen = methods.find((method) => method.id === selected) ?? null

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const form = new FormData(event.currentTarget)
    const body = {
      // The honeypot the endpoint expects; a human never sees it, a bot always fills it.
      company: String(form.get('company') ?? ''),
      email: String(form.get('email') ?? '').trim() || undefined,
      // Absent when there is no picker: an empty string would be a gateway named `''`,
      // and the endpoint refuses a name it does not recognise.
      ...(chosen ? { gateway: chosen.id } : {}),
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
        methods?: PaymentMethodOption[]
        ok?: boolean
        redirectUrl?: null | string
      }

      // A refusal that came with a list means "not that one, for this basket". Show the
      // list and stay on the form; the order was never created, so there is nothing to
      // confirm and no `confirmationUrl` to follow.
      if (!response.ok && Array.isArray(result.methods)) {
        setMethods(result.methods)
        setSelected(result.methods[0]?.id ?? null)
        setStatus('error')
        setError(result.message || uiString('paymentMethod', locale))

        return
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
          {/* An instalment or wallet gateway identifies the buyer *by* this number, so a
              number that is not theirs is a payment that cannot be collected. The field is
              required either way; the hint is what makes it the right number. */}
          {chosen?.requiresMobile && (
            <p className="text-xs text-muted-foreground">{uiString('mobileHint', locale)}</p>
          )}
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

      {methods.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{uiString('paymentMethod', locale)}</legend>

          <div className="space-y-2">
            {methods.map((method) => {
              const inputId = `${id}-gateway-${method.id}`
              const isChosen = method.id === chosen?.id

              return (
                <label
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors',
                    isChosen
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50',
                  )}
                  htmlFor={inputId}
                  key={method.id}
                >
                  <input
                    checked={isChosen}
                    className="mt-1 size-4 shrink-0"
                    id={inputId}
                    name="gateway"
                    onChange={() => setSelected(method.id)}
                    type="radio"
                    value={method.id}
                  />

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium">
                        {locale === 'fa' ? method.label : method.labelEn || method.label}
                      </span>

                      {/* A credit product is a different agreement, not a different button
                          colour: the buyer is taking a loan, and the label has to say so
                          before they commit rather than on the PSP's own page. */}
                      {method.kind === 'bnpl' && (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                          {uiString('instalments', locale)}
                        </span>
                      )}

                      {/* Loud on purpose. A shop left in sandbox takes orders that never
                          settle, and the person who has to notice is the buyer's. */}
                      {method.mode === 'sandbox' && (
                        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive">
                          {uiString('sandbox', locale)}
                        </span>
                      )}

                      {typeof method.minAmount === 'number' && method.minAmount > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {formatPrice(method.minAmount, currency, locale)}+
                        </span>
                      )}
                    </span>

                    {method.blurb && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {method.blurb}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>
      )}

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
