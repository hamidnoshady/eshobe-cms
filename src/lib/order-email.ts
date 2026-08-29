import type { PayloadRequest } from 'payload'

import type { Order, Site } from '@/payload-types'

import { formatPrice } from './format'

/**
 * The buyer's receipt, sent when a payment is confirmed.
 *
 * Deliberately tiny: plain text plus a minimal HTML part, no template engine, no
 * layout. It restates what the receipt page says — code, amount, what was bought — because
 * that is the message a buyer forwards when something goes wrong, and it must be
 * readable in an email client ten years from now.
 *
 * **Never fails the order.** The money has already moved by the time this runs; an SMTP
 * outage is a support ticket, not a licence to lose a paid order. Payload's default
 * adapter logs to the console, which is why no `if (adapter configured)` guard exists —
 * configuring a real transport is a deployment step (`.env.example`), not a code path.
 */
export const sendOrderReceipt = async ({
  locale,
  order,
  req,
  site,
}: {
  locale: string
  order: Order
  req: PayloadRequest
  site: Site
}): Promise<'sent' | 'skipped'> => {
  const to = order.buyer?.email

  if (!to) return 'skipped'

  const amount = formatPrice(order.total, order.currency, locale)
  const lines = [
    `سفارش ${order.reference ?? order.id}`,
    `${order.productTitle ?? 'محصول'} — ${order.quantity ?? 1} عدد`,
    `مبلغ: ${amount}`,
    order.status === 'paid' ? 'پرداخت تأیید شد.' : 'سفارش در انتظار پرداخت است.',
  ]

  await req.payload.sendEmail({
    html: lines.map((line) => `<p>${line}</p>`).join(''),
    from: process.env.EMAIL_FROM ?? `noreply@${site.domain}`,
    subject: `سفارش ${order.reference ?? order.id} — ${site.name}`,
    text: lines.join('\n'),
    to,
  })

  return 'sent'
}
