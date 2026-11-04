import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PayloadRequest } from 'payload'

import type { Customer, Site } from '@/payload-types'
import { formatDate } from '@/lib/format'
import { idOf, isUuid } from '@/lib/ids'

import { recordMigrationAudit } from './records'

/**
 * Customer account-claim invitations for migrated WooCommerce profiles.
 *
 * A Woo customer is imported as a `customers` profile, never as a CMS user
 * and never with a transplanted WordPress password hash. This module is the
 * safe bridge between that profile and whatever account system the
 * storefront theme owns: an owner issues a one-time, expiring token to the
 * customer's imported email address; only its SHA-256 hash is stored; the
 * theme exchanges the token once and receives the verified customer identity
 * it may bind to its own account/session. The exchange deliberately returns
 * identity fields only — not addresses, order history or provenance.
 */

export const CUSTOMER_CLAIM_DEFAULT_TTL_DAYS = 7
export const CUSTOMER_CLAIM_MAX_TTL_DAYS = 30
export const CUSTOMER_CLAIM_MAX_BULK = 100

export class CustomerClaimError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'CustomerClaimError'
    this.status = status
  }
}

export type CustomerClaimView = {
  claimExpiresAt: null | string
  claimStatus: string
  claimedAt: null | string
  displayName: null | string
  email: null | string
  firstName: null | string
  id: string
  invitedAt: null | string
  lastName: null | string
  status: string
}

export type ClaimedCustomerView = {
  displayName: null | string
  email: null | string
  firstName: null | string
  id: string
  lastName: null | string
}

export type CustomerClaimDelivery = (args: {
  claimUrl: string
  customer: Customer
  expiresAt: string
  req: PayloadRequest
  site: Site
  token: string
}) => Promise<void>

const normalizeEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export const hashCustomerClaimToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

const hashesEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const customerClaimView = (customer: Customer): CustomerClaimView => ({
  claimExpiresAt: customer.claimExpiresAt ?? null,
  claimStatus: String(customer.claimStatus ?? 'unclaimed'),
  claimedAt: customer.claimedAt ?? null,
  displayName: customer.displayName ?? null,
  email: customer.email ?? null,
  firstName: customer.firstName ?? null,
  id: String(customer.id),
  invitedAt: customer.invitedAt ?? null,
  lastName: customer.lastName ?? null,
  status: String(customer.status ?? 'active'),
})

const claimedCustomerView = (customer: Customer): ClaimedCustomerView => ({
  displayName: customer.displayName ?? null,
  email: customer.email ?? null,
  firstName: customer.firstName ?? null,
  id: String(customer.id),
  lastName: customer.lastName ?? null,
})

const findSite = async (req: PayloadRequest, siteId: string): Promise<null | Site> => {
  if (!isUuid(siteId)) return null

  return (await req.payload.findByID({
    id: siteId,
    collection: 'sites',
    depth: 0,
    disableErrors: true,
    overrideAccess: true,
    req,
  })) as null | Site
}

const isMigratedWooCustomer = (customer: Customer): boolean =>
  customer.source?.system === 'woocommerce' &&
  customer.source?.sourceType === 'customer' &&
  Boolean(customer.source?.sourceId?.trim())

const findCustomer = async (
  req: PayloadRequest,
  siteId: string,
  customerId: string,
): Promise<Customer | null> => {
  if (!isUuid(customerId)) return null

  const { docs } = await req.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: { and: [{ id: { equals: customerId } }, { site: { equals: siteId } }] },
  })

  return (docs[0] as Customer | undefined) ?? null
}

export const buildCustomerClaimUrl = ({
  claimUrl,
  site,
  token,
}: {
  claimUrl?: string
  site: Site
  token: string
}): string => {
  const raw = claimUrl?.trim() || `https://${site.domain}/account/claim`
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new CustomerClaimError('نشانی صفحه مطالبه حساب معتبر نیست.', 400)
  }

  const localHttp =
    url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) {
    throw new CustomerClaimError(
      'نشانی صفحه مطالبه حساب باید HTTPS و بدون نام کاربری/گذرواژه باشد.',
      400,
    )
  }

  url.searchParams.set('token', token)
  return url.toString()
}

const deliverCustomerClaimEmail: CustomerClaimDelivery = async ({
  claimUrl,
  customer,
  expiresAt,
  req,
  site,
}) => {
  const email = normalizeEmail(customer.email)
  const locale = site.defaultLocale === 'en' ? 'en' : 'fa'
  const name =
    customer.displayName || `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim()
  const expiry = formatDate(expiresAt, locale, { dateStyle: 'long', timeStyle: 'short' })
  const lines =
    locale === 'en'
      ? [
          name ? `Hello ${name},` : 'Hello,',
          `Your customer profile from ${site.name} has moved to the new store. Use the one-time link below to verify this email address and claim your account:`,
          claimUrl,
          `This link expires on ${expiry} and can be used once. If you did not expect this email, you can ignore it.`,
        ]
      : [
          name ? `سلام ${name}،` : 'سلام،',
          `پروفایل مشتری شما در فروشگاه «${site.name}» به فروشگاه تازه منتقل شده است. برای تأیید این رایانامه و مطالبه حساب، از پیوند یک‌بارمصرف زیر استفاده کنید:`,
          claimUrl,
          `این پیوند تا ${expiry} معتبر است و فقط یک بار کار می‌کند. اگر منتظر این پیام نبوده‌اید، آن را نادیده بگیرید.`,
        ]

  await req.payload.sendEmail({
    html: lines
      .map((line, index) =>
        index === 2
          ? `<p><a href="${escapeHtml(line)}">${escapeHtml(line)}</a></p>`
          : `<p>${escapeHtml(line)}</p>`,
      )
      .join(''),
    subject:
      locale === 'en'
        ? `Claim your ${site.name} account`
        : `مطالبه حساب مشتری — ${site.name}`,
    text: lines.join('\n\n'),
    to: email,
  })
}

const assertTtl = (value: number | undefined): number => {
  const days = value ?? CUSTOMER_CLAIM_DEFAULT_TTL_DAYS
  if (!Number.isInteger(days) || days < 1 || days > CUSTOMER_CLAIM_MAX_TTL_DAYS) {
    throw new CustomerClaimError('مهلت دعوت باید عددی میان ۱ تا ۳۰ روز باشد.', 400)
  }
  return days
}

export const issueCustomerClaimInvitation = async (
  req: PayloadRequest,
  {
    claimUrl,
    customerId,
    deliver = deliverCustomerClaimEmail,
    expiresInDays,
    now = new Date(),
    siteId,
  }: {
    claimUrl?: string
    customerId: string
    deliver?: CustomerClaimDelivery
    expiresInDays?: number
    now?: Date
    siteId: string
  },
): Promise<{ customer: CustomerClaimView; expiresAt: string }> => {
  const [site, customer] = await Promise.all([
    findSite(req, siteId),
    findCustomer(req, siteId, customerId),
  ])

  if (!site) throw new CustomerClaimError('سایت یافت نشد.', 404)
  if (!customer) throw new CustomerClaimError('مشتری در این سایت یافت نشد.', 404)
  if (!isMigratedWooCustomer(customer)) {
    throw new CustomerClaimError(
      'این پروفایل مشتری از ووکامرس مهاجرت نکرده است و از مرکز مهاجرت دعوت نمی‌شود.',
      409,
    )
  }
  if (customer.status !== 'active') {
    throw new CustomerClaimError('مشتری غیرفعال یا مسدود است و دعوت نمی‌شود.', 409)
  }
  if (customer.claimStatus === 'claimed' || customer.claimStatus === 'disabled') {
    throw new CustomerClaimError('این حساب مشتری دیگر قابل دعوت نیست.', 409)
  }

  const email = normalizeEmail(customer.email)
  if (!isEmail(email)) {
    throw new CustomerClaimError('مشتری رایانامه معتبر ندارد؛ دعوت ایمیلی ممکن نیست.', 422)
  }

  const token = randomBytes(32).toString('base64url')
  const url = buildCustomerClaimUrl({ claimUrl, site, token })
  const expiresAt = new Date(now.getTime() + assertTtl(expiresInDays) * 24 * 60 * 60 * 1000)

  const updated = (await req.payload.update({
    id: customer.id,
    collection: 'customers',
    data: {
      claimExpiresAt: expiresAt.toISOString(),
      claimStatus: 'invited',
      claimTokenHash: hashCustomerClaimToken(token),
      invitedAt: now.toISOString(),
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as Customer

  try {
    await deliver({
      claimUrl: url,
      customer: { ...updated, email },
      expiresAt: expiresAt.toISOString(),
      req,
      site,
      token,
    })
  } catch (error) {
    // A token nobody received must not stay live. The previous token was
    // rotated by this attempt, so the honest state after a failed resend is
    // unclaimed until the owner retries.
    await req.payload
      .update({
        id: customer.id,
        collection: 'customers',
        data: {
          claimExpiresAt: null,
          claimStatus: 'unclaimed',
          claimTokenHash: null,
          invitedAt: null,
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
      .catch(() => undefined)
    req.payload.logger.error(
      `Customer claim invitation delivery failed for customer ${String(customer.id)}: ${String(error)}`,
    )
    throw new CustomerClaimError('ارسال دعوت مشتری انجام نشد؛ نشانه صادرشده باطل شد.', 502)
  }

  await recordMigrationAudit(req, {
    action: 'customer.claim.invite',
    actorId: idOf(req.user),
    details: { customerId: String(customer.id), expiresAt: expiresAt.toISOString() },
    siteId,
    summary: 'دعوت یک‌بارمصرف مطالبه حساب برای یک مشتری مهاجر ارسال شد.',
  }).catch(() => undefined)

  return { customer: customerClaimView(updated), expiresAt: expiresAt.toISOString() }
}

export const issueCustomerClaimInvitations = async (
  req: PayloadRequest,
  {
    claimUrl,
    deliver,
    expiresInDays,
    limit = CUSTOMER_CLAIM_MAX_BULK,
    resendInvited = false,
    siteId,
  }: {
    claimUrl?: string
    deliver?: CustomerClaimDelivery
    expiresInDays?: number
    limit?: number
    resendInvited?: boolean
    siteId: string
  },
): Promise<{
  failures: { customerId: string; message: string }[]
  invited: CustomerClaimView[]
  requested: number
}> => {
  if (!isUuid(siteId)) throw new CustomerClaimError('شناسه سایت معتبر نیست.', 400)
  const boundedLimit = Math.min(CUSTOMER_CLAIM_MAX_BULK, Math.max(1, Math.trunc(limit) || 1))
  const statuses = resendInvited ? ['invited', 'unclaimed'] : ['unclaimed']
  const { docs } = await req.payload.find({
    collection: 'customers',
    depth: 0,
    limit: boundedLimit,
    overrideAccess: true,
    req,
    sort: 'createdAt',
    where: {
      and: [
        { site: { equals: siteId } },
        { status: { equals: 'active' } },
        { claimStatus: { in: statuses } },
        { email: { exists: true } },
        { 'source.system': { equals: 'woocommerce' } },
        { 'source.sourceType': { equals: 'customer' } },
        { 'source.sourceId': { exists: true } },
      ],
    } as never,
  })

  const invited: CustomerClaimView[] = []
  const failures: { customerId: string; message: string }[] = []

  for (const doc of docs as Customer[]) {
    try {
      const result = await issueCustomerClaimInvitation(req, {
        claimUrl,
        customerId: String(doc.id),
        ...(deliver ? { deliver } : {}),
        expiresInDays,
        siteId,
      })
      invited.push(result.customer)
    } catch (error) {
      failures.push({
        customerId: String(doc.id),
        message: error instanceof Error ? error.message : 'ارسال دعوت انجام نشد.',
      })
    }
  }

  return { failures, invited, requested: docs.length }
}

export const exchangeCustomerClaimToken = async (
  req: PayloadRequest,
  {
    now = new Date(),
    siteId,
    token,
  }: {
    now?: Date
    siteId: string
    token: string
  },
): Promise<null | { claimedAt: string; customer: ClaimedCustomerView }> => {
  const candidate = typeof token === 'string' ? token.trim() : ''
  if (!isUuid(siteId) || candidate.length < 32 || candidate.length > 200) return null

  const tokenHash = hashCustomerClaimToken(candidate)
  const { docs } = await req.payload.find({
    collection: 'customers',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    req,
    where: {
      and: [{ site: { equals: siteId } }, { claimTokenHash: { equals: tokenHash } }],
    } as never,
  })
  if (docs.length !== 1) return null

  const customer = docs[0] as Customer
  const storedHash = typeof customer.claimTokenHash === 'string' ? customer.claimTokenHash : ''
  if (storedHash && !hashesEqual(storedHash, tokenHash)) return null
  if (customer.status !== 'active' || customer.claimStatus !== 'invited') return null

  const expiresAt = customer.claimExpiresAt ? Date.parse(String(customer.claimExpiresAt)) : NaN
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    await req.payload
      .update({
        id: customer.id,
        collection: 'customers',
        data: {
          claimExpiresAt: null,
          claimStatus: 'unclaimed',
          claimTokenHash: null,
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
      .catch(() => undefined)
    return null
  }

  const claimedAt = now.toISOString()
  const updated = (await req.payload.update({
    id: customer.id,
    collection: 'customers',
    data: {
      claimExpiresAt: null,
      claimStatus: 'claimed',
      claimTokenHash: null,
      claimedAt,
    } as never,
    depth: 0,
    overrideAccess: true,
    req,
  })) as Customer

  await recordMigrationAudit(req, {
    action: 'customer.claim.exchange',
    details: { customerId: String(customer.id) },
    siteId,
    summary: 'مشتری با نشانه یک‌بارمصرف، مالکیت رایانامه و حساب مهاجر را تأیید کرد.',
  }).catch(() => undefined)

  return { claimedAt, customer: claimedCustomerView(updated) }
}
