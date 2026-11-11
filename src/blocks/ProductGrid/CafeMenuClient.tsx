'use client'

import React, { useId, useMemo, useRef, useState } from 'react'

import type { ModifierChoice, ModifierSnapshot } from '@/lib/cafe-menu'
import type { PaymentMethodOption } from '@/lib/checkout'
import type { CurrencyCode } from '@/lib/money'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cartFingerprint } from '@/lib/cafe-order'
import { menuAvailability, menuSort, resolveModifiers } from '@/lib/cafe-menu'
import { MAX_ORDER_QUANTITY } from '@/lib/checkout'
import { formatNumber, formatPrice } from '@/lib/format'
import { uiString } from '@/lib/ui-strings'

import type { CafeMenuCategory, CafeMenuItem } from './cafeTypes'

type CartLine = {
  key: string
  productId: string
  title: string
  variation?: string
  variationLabel?: string
  quantity: number
  choices: ModifierChoice[]
  snapshots: ModifierSnapshot[]
  unitPrice: number
}

type Props = {
  categories: CafeMenuCategory[]
  compact?: boolean
  currency: CurrencyCode
  heading?: string | null
  intro?: string | null
  locale: string
  paymentMethods: PaymentMethodOption[]
  products: CafeMenuItem[]
  showBuyButton: boolean
  /**
   * The opaque Biza table token the QR link carried (`?t=…`), if any.
   *
   * The *server* reads it from the URL and passes it down; the client never invents
   * one, never shows it and never edits it. It only decides whether «حضوری» is
   * selectable — and the endpoint re-validates it regardless, because a token that only
   * the browser checked is a token a browser can change.
   */
  tableToken?: null | string
}

/** No account or browser total is authoritative. The cart is only a local draft. */
export const CafeMenuClient: React.FC<Props> = ({ categories, compact = false, currency, heading, intro, locale, paymentMethods, products, showBuyButton, tableToken }) => {
  const id = useId().replace(/:/g, '')
  const hasTable = Boolean(tableToken)
  const [serviceMode, setServiceMode] = useState<'dine_in' | 'takeaway'>(hasTable ? 'dine_in' : 'takeaway')
  const [paymentChoice, setPaymentChoice] = useState<'counter' | 'online'>(paymentMethods.length > 0 ? 'online' : 'counter')
  // One key per cart composition, regenerated whenever the cart changes: a retry of the
  // *same* basket is the same order, and a basket the guest edited is a new one.
  const requestId = useRef<string>('')
  const [cart, setCart] = useState<CartLine[]>([])
  const [status, setStatus] = useState<'idle' | 'sending' | 'error'>('idle')
  const [error, setError] = useState('')
  const [methods, setMethods] = useState(paymentMethods)
  const [gateway, setGateway] = useState(paymentMethods[0]?.id ?? '')
  const assigned = new Set(categories.map((category) => category.id))
  const sections = categories.map((category) => ({ ...category, products: products.filter((product) => product.categoryIds.includes(category.id)) }))
    .filter((category) => category.products.length > 0)
  const other = products.filter((product) => !product.categoryIds.some((categoryId) => assigned.has(categoryId)))
  const estimatedTotal = cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)

  const add = (line: CartLine) => {
    setCart((current) => {
      const existing = current.find((item) => item.key === line.key)
      if (!existing) return current.length >= 50 ? current : [...current, line]
      return current.map((item) => item.key === line.key
        ? { ...item, quantity: Math.min(MAX_ORDER_QUANTITY, item.quantity + line.quantity) }
        : item)
    })
  }

  /**
   * The idempotency key for *this* basket.
   *
   * Derived from the cart's own composition — the same signature the cart uses to
   * decide whether a line is the same line — and regenerated when the guest changes
   * anything. Holding it across a failed submit is the entire point: a lost response
   * followed by a second click must reach the server as a retry, not a second order.
   */
  const basketKey = useMemo(
    // The *same* pure function the endpoint re-computes from server prices, so a client
    // key and a server fingerprint can never disagree about what counts as one basket:
    // changing a quantity, a modifier or a variation all move the key, and re-rendering
    // the same cart does not.
    () => cartFingerprint(cart.map((line) => ({
      modifiers: line.choices,
      productId: line.productId,
      quantity: line.quantity,
      variation: line.variation ?? '',
    }))),
    [cart],
  )

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!cart.length || status === 'sending') return
    if (serviceMode === 'dine_in' && !hasTable) {
      setStatus('error')
      setError(uiString('tableRequired', locale))
      return
    }
    const form = new FormData(event.currentTarget)
    // One key per basket, not per attempt. `crypto.randomUUID` needs a secure context
    // (https, or localhost); a café's preview on http would otherwise throw on submit,
    // so the fallback is the same shape from `Math.random` + the clock.
    const randomId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`)
    if (requestId.current.split(':')[1] !== basketKey) requestId.current = `${randomId()}:${basketKey}`
    setStatus('sending')
    setError('')
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          company: String(form.get('company') ?? ''),
          name: String(form.get('name') ?? '').trim(), phone: String(form.get('phone') ?? '').trim(),
          email: String(form.get('email') ?? '').trim() || undefined,
          note: String(form.get('note') ?? '').trim() || undefined,
          locale,
          serviceMode,
          paymentChoice,
          // The key is the half before the colon; the basket signature stays client-side
          // so the server computes its own fingerprint from the prices it re-read, not
          // from anything this component believes.
          checkoutRequestId: requestId.current.split(':')[0],
          ...(serviceMode === 'dine_in' && tableToken ? { tableToken } : {}),
          ...(paymentChoice === 'online' && gateway ? { gateway } : {}),
          items: cart.map(({ productId, quantity, variation, choices }) => ({
            product: productId, quantity, ...(variation ? { variation } : {}), modifiers: choices,
          })),
        }),
      })
      const result = await response.json() as { confirmationUrl?: string; redirectUrl?: string | null; message?: string; methods?: PaymentMethodOption[] }
      if (!response.ok && !result.confirmationUrl) {
        if (Array.isArray(result.methods)) {
          setMethods(result.methods)
          setGateway(result.methods[0]?.id ?? '')
        }
        setStatus('error')
        setError(result.message || uiString('checkoutFailed', locale))
        return
      }
      const target = result.redirectUrl || result.confirmationUrl
      if (!target) throw new Error('missing checkout destination')
      window.location.assign(target)
    } catch {
      setStatus('error')
      setError(uiString('checkoutFailed', locale))
    }
  }

  return (
    <section className={compact ? '' : 'container'}>
      {(heading || intro) && <div className="mb-8 max-w-2xl">{heading && <h2 className="text-3xl font-bold">{heading}</h2>}{intro && <p className="mt-3 text-muted-foreground">{intro}</p>}</div>}
      <div className={showBuyButton ? 'grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]' : ''}>
        <div className="min-w-0 space-y-10">
          {sections.length > 0 && <nav aria-label={uiString('categories', locale)} className="flex flex-wrap gap-2">
            {sections.map((section) => <a className="rounded-full border border-border px-4 py-2 text-sm hover:bg-muted" href={`#${id}-${section.id}`} key={section.id}>{section.name}</a>)}
            {other.length > 0 && <a className="rounded-full border border-border px-4 py-2 text-sm hover:bg-muted" href={`#${id}-other`}>{uiString('uncategorized', locale)}</a>}
          </nav>}
          {sections.map((section) => <section id={`${id}-${section.id}`} key={section.id} className="scroll-mt-6 space-y-4">
            <div><h3 className="text-2xl font-bold">{section.name}</h3>{section.description && <p className="text-sm text-muted-foreground">{section.description}</p>}</div>
            <div className="grid gap-4 sm:grid-cols-2">{section.products.map((product) => <MenuCard add={add} compact={compact} currency={currency} key={product.id} locale={locale} product={product} showBuyButton={showBuyButton} />)}</div>
          </section>)}
          {other.length > 0 && <section id={`${id}-other`} className="scroll-mt-6 space-y-4">
            {sections.length > 0 && <h3 className="text-2xl font-bold">{uiString('uncategorized', locale)}</h3>}
            <div className={compact ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>{other.map((product) => <MenuCard add={add} compact={compact} currency={currency} key={product.id} locale={locale} product={product} showBuyButton={showBuyButton} />)}</div>
          </section>}
        </div>
        {showBuyButton && <aside aria-label={uiString('cart', locale)} className="rounded-lg border border-border bg-card p-5 lg:sticky lg:top-6">
          <h3 className="text-xl font-bold">{uiString('cart', locale)}</h3>
          {!cart.length ? <p className="mt-4 text-sm text-muted-foreground">{uiString('cartEmpty', locale)}</p> : <>
            <ul className="mt-4 divide-y divide-border">
              {cart.map((line) => <li className="space-y-2 py-3" key={line.key}>
                <div className="flex items-start justify-between gap-2"><div><strong>{line.title}</strong>{line.variationLabel && <span> — {line.variationLabel}</span>}
                  {line.snapshots.map((snapshot) => <div className="text-xs text-muted-foreground" key={`${snapshot.groupSourceId}:${snapshot.optionSourceId}`}>{snapshot.groupLabel}: {snapshot.optionLabel}</div>)}
                </div><span className="text-sm font-medium">{formatPrice(line.unitPrice * line.quantity, currency, locale)}</span></div>
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm">{uiString('quantity', locale)}<input aria-label={`${uiString('quantity', locale)} ${line.title}${line.variationLabel ? ` ${line.variationLabel}` : ''} ${line.snapshots.map((snapshot) => snapshot.optionLabel).join(' ')}`} className="w-16 rounded border border-input bg-background px-2 py-1" max={MAX_ORDER_QUANTITY} min={1} type="number" value={line.quantity} onChange={(event) => {
                    const quantity = Number(event.target.value)
                    if (Number.isInteger(quantity) && quantity >= 1 && quantity <= MAX_ORDER_QUANTITY) setCart((current) => current.map((item) => item.key === line.key ? { ...item, quantity } : item))
                  }} /></label>
                  <button className="text-sm text-destructive underline" type="button" onClick={() => setCart((current) => current.filter((item) => item.key !== line.key))}>{uiString('remove', locale)}</button>
                </div>
              </li>)}
            </ul>
            <div className="flex justify-between gap-2 border-t border-border pt-4 font-bold"><span>{uiString('cartEstimate', locale)}</span><span>{formatPrice(estimatedTotal, currency, locale)}</span></div>
            <p className="mt-1 text-xs text-muted-foreground">{uiString('cartPriceNotice', locale)}</p>
            <form className="mt-5 space-y-3" onSubmit={submit}>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{uiString('serviceMode', locale)}</legend>
                <label className={hasTable ? 'flex items-center gap-2 text-sm' : 'flex items-center gap-2 text-sm opacity-60'}>
                  <input checked={serviceMode === 'dine_in'} disabled={!hasTable} name="serviceMode" onChange={() => setServiceMode('dine_in')} type="radio" value="dine_in" />
                  <span>{uiString('dineIn', locale)}{!hasTable && <span className="block text-xs text-muted-foreground">{uiString('tableCodeHint', locale)}</span>}</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input checked={serviceMode === 'takeaway'} name="serviceMode" onChange={() => setServiceMode('takeaway')} type="radio" value="takeaway" />
                  <span>{uiString('takeaway', locale)}</span>
                </label>
              </fieldset>
              <div><Label htmlFor={`${id}-name`}>{uiString('name', locale)}</Label><Input autoComplete="name" id={`${id}-name`} name="name" required /></div>
              <div><Label htmlFor={`${id}-phone`}>{uiString('phone', locale)}</Label><Input autoComplete="tel" dir="ltr" id={`${id}-phone`} inputMode="tel" name="phone" required /></div>
              <div><Label htmlFor={`${id}-email`}>{uiString('email', locale)}</Label><Input autoComplete="email" dir="ltr" id={`${id}-email`} name="email" type="email" /></div>
              <div><Label htmlFor={`${id}-note`}>{uiString('note', locale)}</Label><Input id={`${id}-note`} maxLength={500} name="note" /></div>
              <fieldset className="space-y-2"><legend className="text-sm font-medium">{uiString('paymentMethod', locale)}</legend>
                {/* Pay at the counter is always offered: the shop is the one place a
                    café guest definitely can pay, and its absence would leave a site
                    with no gateway unable to take an order at all. */}
                <label className="flex items-start gap-2 rounded border border-border p-2 text-sm">
                  <input checked={paymentChoice === 'counter'} name="paymentChoice" onChange={() => setPaymentChoice('counter')} type="radio" value="counter" />
                  <span>{uiString('payAtCounter', locale)}<span className="block text-xs text-muted-foreground">{uiString('payAtCounterHint', locale)}</span></span>
                </label>
                {methods.length > 0 && <label className="flex items-start gap-2 rounded border border-border p-2 text-sm">
                  <input checked={paymentChoice === 'online'} name="paymentChoice" onChange={() => setPaymentChoice('online')} type="radio" value="online" />
                  <span>{uiString('payOnline', locale)}</span>
                </label>}
                {paymentChoice === 'online' && methods.map((method) => <label className="flex items-start gap-2 rounded border border-border p-2 text-sm" key={method.id}>
                  <input checked={gateway === method.id} name="gateway" onChange={() => setGateway(method.id)} type="radio" value={method.id} />
                  <span>{locale === 'fa' ? method.label : method.labelEn || method.label}{method.kind === 'bnpl' && ` — ${uiString('instalments', locale)}`}{method.mode === 'sandbox' && ` — ${uiString('sandbox', locale)}`}{method.requiresMobile && <span className="block text-xs text-muted-foreground">{uiString('mobileHint', locale)}</span>}</span>
                </label>)}
              </fieldset>
              <input aria-hidden autoComplete="off" className="hidden" name="company" tabIndex={-1} type="text" />
              <Button className="w-full" disabled={status === 'sending'} type="submit">{status === 'sending' ? uiString('submitting', locale) : uiString('submit', locale)}</Button>
              {error && <p aria-live="polite" className="text-sm text-destructive">{error}</p>}
            </form>
          </>}
        </aside>}
      </div>
    </section>
  )
}

const MenuCard: React.FC<{ add: (line: CartLine) => void; compact: boolean; currency: CurrencyCode; locale: string; product: CafeMenuItem; showBuyButton: boolean }> = ({ add, compact, currency, locale, product, showBuyButton }) => {
  const id = useId().replace(/:/g, '')
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [variationKey, setVariationKey] = useState(product.variations[0]?.key ?? '')
  const [quantity, setQuantity] = useState(1)
  const variation = product.variations.find((candidate) => candidate.key === variationKey)
  const stock = variation?.trackInventory ? variation : product
  const availability = menuAvailability({ menuAvailability: product.menuAvailability, inventory: stock.inventory, trackInventory: stock.trackInventory })
  const canSellType = !product.productType || product.productType === 'simple' || (product.productType === 'variable' && Boolean(variation))
  const choices = Object.entries(selected).filter(([, values]) => values.length).map(([groupId, optionIds]) => ({ groupId, optionIds: [...optionIds].sort() })).sort((a, b) => a.groupId.localeCompare(b.groupId))
  const selection = resolveModifiers(product.modifierGroups, choices)
  const basePrice = variation?.price ?? product.price
  const unitPrice = basePrice + (selection.ok ? selection.priceDelta : 0)
  const canAdd = availability === 'available' && canSellType && selection.ok && Number.isSafeInteger(unitPrice) && unitPrice > 0
  const max = stock.trackInventory && typeof stock.inventory === 'number' ? Math.max(1, Math.min(MAX_ORDER_QUANTITY, stock.inventory)) : MAX_ORDER_QUANTITY
  const groups = menuSort(product.modifierGroups).filter((group) => group.active !== false)

  const addCurrent = () => {
    if (!canAdd || !selection.ok) return
    add({
      key: JSON.stringify([product.id, variation?.key ?? '', choices]), productId: product.id, title: product.title,
      ...(variation ? { variation: variation.key, variationLabel: variation.label } : {}),
      quantity: Math.min(quantity, max), choices, snapshots: selection.snapshots, unitPrice,
    })
  }

  return <article className="overflow-hidden rounded-lg border border-border bg-card">
    {!compact && <div className="relative aspect-[4/3] bg-muted">{product.image}{availability !== 'available' && <span className="absolute end-3 top-3 rounded bg-background/90 px-2 py-1 text-xs font-medium">{uiString(availability === 'sold_out' ? 'outOfStock' : 'unavailable', locale)}</span>}</div>}
    <div className="space-y-3 p-4">
      {!compact && <><h4 className="text-lg font-semibold">{product.title}</h4>
      {product.summary && <p className="text-sm text-muted-foreground">{product.summary}</p>}
      <p className="text-lg font-bold">{formatPrice(basePrice, currency, locale)}</p></>}
      {compact && availability !== 'available' && <p className="text-sm text-muted-foreground">{uiString(availability === 'sold_out' ? 'outOfStock' : 'unavailable', locale)}</p>}
      {product.productType === 'variable' && product.variations.length > 0 && <div><Label htmlFor={`${id}-variation`}>{uiString('chooseOptions', locale)}</Label>
        <select className="mt-1 w-full rounded border border-input bg-background px-3 py-2" id={`${id}-variation`} value={variationKey} onChange={(event) => setVariationKey(event.target.value)}>{product.variations.map((option) => <option key={option.key} value={option.key}>{option.label} — {formatPrice(option.price, currency, locale)}</option>)}</select>
      </div>}
      {groups.map((group) => <fieldset className="space-y-2 border-t border-border pt-3" key={group.sourceId}>
        <legend className="text-sm font-semibold">{group.label} <span className="font-normal text-muted-foreground">({uiString(group.minSelections > 0 ? 'requiredChoice' : 'optionalChoice', locale)})</span></legend>
        <p className="text-xs text-muted-foreground">{uiString('chooseFrom', locale)}: {formatNumber(group.minSelections, locale)}–{formatNumber(group.maxSelections, locale)}</p>
        {menuSort(group.options ?? []).filter((option) => option.active !== false).map((option) => {
          const current = selected[group.sourceId] ?? []
          const checked = current.includes(option.sourceId)
          return <label className="flex items-center justify-between gap-2 text-sm" key={option.sourceId}>
            <span className="flex items-center gap-2"><input checked={checked} disabled={!checked && current.length >= group.maxSelections} type="checkbox" onChange={() => setSelected((previous) => ({ ...previous, [group.sourceId]: checked ? current.filter((value) => value !== option.sourceId) : [...current, option.sourceId] }))} />{option.label}</span>
            {option.priceDelta !== 0 && <span className="text-xs text-muted-foreground"><bdi>{option.priceDelta > 0 ? '+' : '−'}{formatPrice(Math.abs(option.priceDelta), currency, locale)}</bdi></span>}
          </label>
        })}
      </fieldset>)}
      {showBuyButton && <>
        {!selection.ok && groups.length > 0 && <p className="text-xs text-muted-foreground">{uiString('invalidSelection', locale)}</p>}
        <div className="flex items-end gap-3"><div className="w-24"><Label htmlFor={`${id}-quantity`}>{uiString('quantity', locale)}</Label><Input id={`${id}-quantity`} max={max} min={1} type="number" value={Math.min(quantity, max)} onChange={(event) => { const next = Number(event.target.value); if (Number.isInteger(next) && next >= 1 && next <= max) setQuantity(next) }} /></div>
          <Button className="flex-1" disabled={!canAdd} onClick={addCurrent} type="button">{uiString('addToCart', locale)}</Button></div>
      </>}
    </div>
  </article>
}
