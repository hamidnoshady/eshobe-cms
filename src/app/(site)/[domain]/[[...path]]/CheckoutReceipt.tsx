import type { Metadata } from 'next'

import { notFound } from 'next/navigation'
import React from 'react'

import { formatPrice, toLocaleDigits } from '@/lib/format'
import { readOrderForReceipt } from '@/lib/order-receipt'
import { getSiteContext } from '@/lib/site-context'
import { uiString } from '@/lib/ui-strings'

/**
 * The buyer's own receipt — the only page in the app that reads an order without a
 * logged-in user, and it does so only through a signed link
 * (`src/lib/order-receipt.ts`).
 *
 * Rendered *through* the `[domain]/[[...path]]` catch-all (`src/lib/site-route.ts`)
 * rather than as its own folder, because the locale segment sits between the domain and
 * the route: a static `[domain]/checkout/[order]` folder would answer `/checkout/…` and
 * 404 on `/en/checkout/…`. `checkout` is in `RESERVED_PAGE_SLUGS`, so no CMS page can
 * claim the word and be silently shadowed by it.
 */
type Props = {
  /** `?m=failed` from the gateway's return, when verification refused. */
  outcome?: string
  order: null | string
  /** The HMAC over `order + site`; without a valid one this page does not exist. */
  receipt?: string
}

export const CheckoutReceipt: React.FC<Props> = async ({ order: orderId, outcome, receipt }) => {
  const { locale, site } = await getSiteContext()

  if (!site || !orderId) notFound()

  const found = await readOrderForReceipt({
    locale,
    orderId,
    receipt,
    siteId: String(site.id),
  })

  if (!found) notFound()

  const { instructions, order } = found

  const paid = order.status === 'paid'

  return (
    <article className="container pt-16 pb-24">
      <div className="max-w-xl">
        <h1 className="text-3xl font-bold">
          {paid ? 'پرداخت ثبت شد' : 'سفارش شما ثبت شد'}
        </h1>

        <p className="mt-3 text-muted-foreground">
          {paid
            ? 'مبلغ دریافت شد. فروشگاه برای هماهنگی ارسال با شما تماس می‌گیرد.'
            : 'این سفارش هنوز پرداخت‌نشده است. شمارهٔ پیگیری را نگه دارید.'}
        </p>

        {outcome === 'failed' && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            درگاه، پرداخت را تأیید نکرد. اگر مبلغ کسر شده است، با فروشگاه تماس بگیرید.
          </p>
        )}

        <dl className="mt-8 divide-y divide-border border-y border-border">
          <Row label="کد پیگیری" value={<bdi>{toLocaleDigits(String(order.reference ?? order.id), locale)}</bdi>} />
          <Row label={uiString('name', locale)} value={order.buyer?.name ?? '—'} />
          <Row
            label={uiString('phone', locale)}
            value={
              order.buyer?.phone ? (
                <a className="hover:underline" href={`tel:${order.buyer.phone}`}>
                  <bdi>{toLocaleDigits(order.buyer.phone, locale)}</bdi>
                </a>
              ) : (
                '—'
              )
            }
          />
          <Row label={uiString('quantity', locale)} value={toLocaleDigits(String(order.quantity ?? 1), locale)} />
          <Row label="محصول" value={order.productTitle ?? '—'} />
          <Row
            label="مبلغ کل"
            value={<span className="font-bold">{formatPrice(order.total, order.currency, locale)}</span>}
          />
        </dl>

        {!paid && instructions && (
          <section className="mt-8 rounded-lg border border-border bg-card p-6">
            <h2 className="text-lg font-semibold">نحوهٔ پرداخت</h2>
            <p className="mt-3 text-muted-foreground whitespace-pre-line">{instructions}</p>
          </section>
        )}

        {order.buyer?.note && (
          <section className="mt-8">
            <h2 className="text-lg font-semibold">یادداشت شما</h2>
            <p className="mt-3 text-muted-foreground whitespace-pre-line">{order.buyer.note}</p>
          </section>
        )}
      </div>
    </article>
  )
}

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-4 py-3">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="text-end">{value}</dd>
  </div>
)

export const checkoutMetadata: Metadata = {
    // A receipt is not content: no index, no OG card, and never a canonical back to
    // the site's own pages.
  robots: 'noindex, nofollow',
  title: 'سفارش',
}
