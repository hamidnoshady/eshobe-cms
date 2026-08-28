import type { Payload, TypedLocale } from 'payload'

import configPromise from '@payload-config'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { getPayload } from 'payload'

import type { Order } from '@/payload-types'

import { isUuid } from './ids'

/**
 * A signed link to one buyer's own order.
 *
 * ## Why this exists at all
 *
 * `orders.read` is `authenticated` — an order is never publicly listable, and an id
 * is not a capability. But a buyer who is not a site's staff member still has to see
 * what they just bought, what to transfer, and that it was recorded. A session would
 * mean building storefront accounts; a signed receipt means a URL.
 *
 * So the page is reachable only with `?r=<signature>` over `orderId + siteId`, keyed
 * by `PAYLOAD_SECRET`. That gives the read below permission to bypass access control
 * *for exactly one document*, which is what the signature buys — and nothing else
 * about the collection becomes public.
 *
 * ## What it does not do
 *
 * No expiry. The link is a receipt, not a token: it names one order and reveals no
 * more than the buyer already typed into the form. Revoking a leaked link means
 * rotating `PAYLOAD_SECRET`, which is recorded in `WAVE-7.md` next to the other
 * deployment consequences.
 */

const RECEIPT_LENGTH = 22 // 128 bits of a 256-bit HMAC, base64url

const secret = (): string => {
  const value = process.env.PAYLOAD_SECRET

  if (!value) {
    throw new Error('PAYLOAD_SECRET is not set — order receipts cannot be signed.')
  }

  return value
}

const sign = (orderId: string, siteId: string): string =>
  createHmac('sha256', secret())
    .update(`eshobe-order-receipt:v1:${siteId}:${orderId}`)
    .digest('base64url')
    .slice(0, RECEIPT_LENGTH)

export const signOrderReceipt = ({ orderId, siteId }: { orderId: string; siteId: string }) =>
  sign(orderId, siteId)

export const verifyOrderReceipt = ({
  orderId,
  receipt,
  siteId,
}: {
  orderId: string
  receipt: null | string | string[] | undefined
  siteId: string
}): boolean => {
  if (typeof receipt !== 'string' || !receipt) return false

  const expected = Buffer.from(sign(orderId, siteId), 'utf8')
  const given = Buffer.from(receipt.slice(0, 64), 'utf8')

  // `timingSafeEqual` throws on a length mismatch, and the length itself is not a
  // secret here — a truncating compare would be.
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * The buyer's order, for one site, receipt verified.
 *
 * The *only* front-end path that reads `orders` with `overrideAccess: true`. Both
 * queries carry the site predicate: the signature authorises reading this order, not
 * reading it off another tenant's domain, and `paymentInstructions` is field-locked to
 * staff for everything that is not this page.
 */
export const readOrderForReceipt = async ({
  locale,
  orderId,
  receipt,
  siteId,
}: {
  locale?: TypedLocale
  orderId: unknown
  receipt: null | string | string[] | undefined
  siteId: string
}): Promise<null | { instructions?: string; order: Order }> => {
  if (!isUuid(orderId)) return null
  if (!verifyOrderReceipt({ orderId: String(orderId), receipt, siteId })) return null

  const payload = await getPayload({ config: configPromise })

  return readOrderDocs(payload, String(orderId), siteId, locale)
}

/**
 * Shared with the checkout flow, which has already proven the order is this site's.
 *
 * `locale` is the *page's* locale, not the site's default: `paymentInstructions` is
 * localized, and `localization.fallback` falls back to the default locale only — so a
 * read in the wrong locale returns `null` and the buyer gets a receipt with no way to
 * pay, which is invisible in the admin and obvious on the storefront.
 */
export const readOrderDocs = async (
  payload: Payload,
  orderId: string,
  siteId: string,
  locale?: TypedLocale,
): Promise<null | { instructions?: string; order: Order }> => {
  const { docs } = await payload.find({
    collection: 'orders',
    locale,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: {
      and: [{ id: { equals: orderId } }, { site: { equals: siteId } }],
    },
  })

  const order = docs[0] as Order | undefined

  if (!order) return null

  const store = await payload.find({
    collection: 'store',
    depth: 0,
    locale,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { site: { equals: siteId } },
  })

  const instructions = (store.docs[0] as { paymentInstructions?: string } | undefined)
    ?.paymentInstructions

  return { instructions: instructions || undefined, order }
}
