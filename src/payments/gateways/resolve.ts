import type { PayloadRequest, TypedLocale } from 'payload'

import type { CurrencyCode } from '@/lib/money'
import type { PaymentGateway } from '@/payload-types'
import type { CheckoutOrder } from '../types'
import type {
  GatewayAdapter,
  GatewayDescriptor,
  GatewayId,
  GatewayMode,
  GatewayProbeContext,
} from './types'

import { rialToToman } from '@/lib/money'
import { isUuid } from '@/lib/ids'
import { siteOrigin } from '@/lib/site-url'

import { minAmountRialFor } from './adapters/snappPay'
import { gatewayAdapters } from './adapters'
import { decryptSecret, isEncrypted, signGatewayState } from './crypto'
import { gatewayDescriptor, isGatewayId, keysForGateway, missingCredentials } from './registry'
import { isIranianCurrency } from './types'

/**
 * The runtime half of the module: *which* gateways a given site may use right now, and
 * the decrypted credentials to do it with.
 *
 * Three switches have to agree before a buyer is offered a gateway, and they are checked
 * here in one place so they cannot be checked in three:
 *
 * 1. **The platform's** — the `payments` global (`src/globals/Payments.ts`). Turning this
 *    off stops every tenant at once, which is what "a module that can be switched off in
 *    the CMS" has to mean when the thing being switched moves money.
 * 2. **The platform's per-gateway allowlist** — a PSP the platform has not signed up for,
 *    or has dropped, is not something a tenant can turn on for itself.
 * 3. **The tenant's row** — `enabled`, complete credentials, and an amount window that
 *    contains this order.
 *
 * Everything this module returns is either public-safe (`EnabledGateway`, which is what
 * `GET /api/payments/methods` serialises) or a decrypted secret that never leaves the
 * request (`ResolvedGateway`). There is no shape here that holds a plaintext credential and
 * is safe to return to a caller.
 */

/** Set by this module before an internal read, and cleared by nothing — see `PaymentGateways`. */
export const SECRET_READ_CONTEXT_KEY = 'eshobePaymentGatewaySecrets'

export type PaymentsModuleState = {
  allowed: GatewayId[]
  enabled: boolean
}

/**
 * The platform's switch.
 *
 * A deployment that has never opened the `payments` global gets `{ enabled: true, allowed:
 * everything }`, which sounds like the unsafe default and is not: a row's `enabled` defaults
 * to **false**, credentials can only be written by a platform admin, and `resolveGateway`
 * refuses a row with none. So nothing can transact until somebody has deliberately
 * configured it, and a fresh install does not have to visit a global before the admin UI
 * will even offer the four gateways.
 */
export const paymentsModuleState = async (req: PayloadRequest): Promise<PaymentsModuleState> => {
  const all = Object.keys(gatewayAdapters) as GatewayId[]

  let doc: null | Record<string, unknown> = null

  try {
    doc = (await req.payload.findGlobal({
      depth: 0,
      // The global's own `read` is `platformAdmin`; this answer decides what a *buyer* is
      // offered, and a buyer has no user. What is read out of it is two booleans and a list
      // of gateway ids — never a credential, because the global holds none.
      overrideAccess: true,
      req,
      slug: 'payments',
    })) as unknown as Record<string, unknown>
  } catch (error) {
    // A missing global (mid-migration, or a database that has not been migrated yet) must
    // not take the storefront down. Logged, then treated as "off": the safe direction is
    // no gateway, and a shop that cannot take online payment still takes orders.
    req.payload.logger.error({
      err: error as Error,
      msg: 'payments global unreadable — the gateway module is treated as disabled',
    })

    return { allowed: [], enabled: false }
  }

  const allowedRaw = Array.isArray(doc?.allowedGateways) ? (doc.allowedGateways as unknown[]) : []
  const allowed = allowedRaw.filter(isGatewayId)

  return {
    // An unsaved global comes back with its defaults; only an explicit `false` is off.
    enabled: doc?.moduleEnabled !== false,
    allowed: allowed.length ? allowed : all,
  }
}

/** What the storefront may know about one gateway. No ids from our database, no credentials. */
export type EnabledGateway = {
  blurb: string
  id: GatewayId
  kind: 'bnpl' | 'psp'
  label: string
  labelEn: string
  /** In the site's own currency minor units, or `null` when the provider sets no bound. */
  maxAmount: null | number
  minAmount: null | number
  mode: GatewayMode
  priority: number
  requiresMobile: boolean
}

/** One gateway, ready to be called. Holds plaintext secrets; never serialised. */
export type ResolvedGateway = {
  adapter: GatewayAdapter
  credentials: Record<string, string>
  descriptor: GatewayDescriptor
  mode: GatewayMode
  rowId: string
  settings: Record<string, string>
}

export type GatewayResolution =
  | { gateway: ResolvedGateway; ok: true }
  | { ok: false; reason: string }

/**
 * A Rial figure in the site's own unit, so a provider's minimum can be compared against an
 * order total without the caller knowing which unit either is in.
 */
export const rialInSiteUnit = (rial: number, currency: CurrencyCode): null | number => {
  if (!isIranianCurrency(currency)) return null

  if (currency === 'IRR') return rial

  try {
    return rialToToman(rial)
  } catch {
    // A provider minimum that is not a whole Toman (nobody's is) rounds up rather than
    // throwing: refusing to offer a gateway because of a rounding rule is the wrong answer,
    // and offering it one Toman too cheap is not.
    return Math.ceil(rial / 10)
  }
}

/**
 * The amount window one row imposes, in the site's currency.
 *
 * Two sources, and the *intersection* is what counts: the tenant's own `minAmount`/
 * `maxAmount` (a shop that does not want instalments on a ۵٬۰۰۰ تومان item), and the
 * provider's floor (Snapp!Pay will not finance below its minimum, and a buyer who finds
 * that out on the PSP's page has already been promised a payment method).
 */
export const amountWindow = (
  row: PaymentGateway,
  currency: CurrencyCode,
): { maxAmount: null | number; minAmount: null | number } => {
  const providerMinimum =
    row.gateway === 'snappPay'
      ? rialInSiteUnit(minAmountRialFor(readSettings(row)), currency)
      : null

  const rowMinimum = typeof row.minAmount === 'number' && row.minAmount > 0 ? row.minAmount : null

  return {
    maxAmount: typeof row.maxAmount === 'number' && row.maxAmount > 0 ? row.maxAmount : null,
    minAmount:
      providerMinimum !== null && rowMinimum !== null
        ? Math.max(providerMinimum, rowMinimum)
        : (providerMinimum ?? rowMinimum),
  }
}

/**
 * A row's settings, decrypted-or-not as stored.
 *
 * `credentials` and `settings` are one group in the document and one map here: which key is
 * a secret is a property of the *catalogue* (`registry.ts`), not of the row, and an adapter
 * that had to know would have to be told twice.
 */
const readSettings = (row: PaymentGateway): Record<string, string> => {
  const values = (row.credentials ?? {}) as Record<string, unknown>

  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => typeof value === 'string' && value !== '')
      // An undecryptable value (a rotated key, a row copied between environments) reads as
      // absent, so `missingCredentials` reports it and the gateway is refused — rather than
      // a ciphertext string being sent to a PSP as a password.
      .map(([key, value]) => [key, isEncrypted(value) ? (decryptSecret(value) ?? '') : String(value)]),
  )
}

const toEnabledGateway = (
  row: PaymentGateway,
  currency: CurrencyCode,
  label?: null | string,
): EnabledGateway => {
  const descriptor = gatewayDescriptor(row.gateway as GatewayId)
  const { maxAmount, minAmount } = amountWindow(row, currency)

  return {
    blurb: descriptor.blurb,
    id: descriptor.id,
    kind: descriptor.kind,
    label: label?.trim() || descriptor.label,
    labelEn: descriptor.labelEn,
    maxAmount,
    minAmount,
    mode: (row.mode ?? 'live') as GatewayMode,
    priority: Number(row.priority ?? 100),
    requiresMobile: descriptor.requiresMobile,
  }
}

type RowQuery = {
  currency: CurrencyCode
  locale?: TypedLocale
  req: PayloadRequest
  siteId: string
}

/**
 * This site's enabled gateway rows, ordered for the storefront.
 *
 * `overrideAccess: true` with an explicit `site` predicate, for the same reason
 * `readOrderDocs` does it: the caller is a buyer with no session, the tenant has already
 * been established from the `Host`, and the collection's own `read` is staff-only because a
 * row's *existence* is not public information even though its label is. The predicate is
 * written here rather than left to access control.
 *
 * The credential columns are read — under the internal flag, so unmasked — for exactly one
 * reason: `amountWindow` needs Snapp!Pay's configured `minAmountRial` to decide whether to
 * offer the gateway for this order at all. Nothing decrypted here reaches the response; what
 * `EnabledGateway` carries is the derived minimum in the site's own unit.
 */
const enabledRows = async ({
  currency,
  locale,
  req,
  siteId,
}: RowQuery): Promise<EnabledGateway[]> => {
  const { enabled: moduleEnabled, allowed } = await paymentsModuleState(req)

  if (!moduleEnabled || !allowed.length) return []

  req.context[SECRET_READ_CONTEXT_KEY] = true

  let docs: PaymentGateway[]

  try {
    const result = await req.payload.find({
      collection: 'payment-gateways',
      depth: 0,
      limit: 50,
      locale,
      overrideAccess: true,
      pagination: false,
      req,
      select: {
        credentials: true,
        displayName: true,
        enabled: true,
        gateway: true,
        maxAmount: true,
        minAmount: true,
        mode: true,
        priority: true,
      },
      where: {
        and: [
          { site: { equals: siteId } },
          { enabled: { equals: true } },
          { gateway: { in: allowed } },
        ],
      },
    })

    docs = result.docs as PaymentGateway[]
  } finally {
    delete req.context[SECRET_READ_CONTEXT_KEY]
  }

  return docs
    .map((row) => toEnabledGateway(row, currency, row.displayName ?? null))
    // Priority ascending, then the registry's own order: an unstable tie-break would make two
    // rows at priority 100 appear in whatever order Postgres returned them, which is a
    // storefront whose default payment method changes between requests.
    .sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)))
}

/**
 * The gateways a buyer may choose from, filtered to what this order can actually use.
 *
 * `amount` is optional because the storefront's product card does not know the quantity
 * yet: it shows every enabled gateway, and the checkout endpoint re-checks the window when
 * the buyer commits. A gateway offered and then refused is a worse experience than one
 * never shown, which is why both halves filter.
 */
export const listEnabledGateways = async ({
  amount,
  ...query
}: RowQuery & { amount?: null | number }): Promise<EnabledGateway[]> => {
  const gateways = await enabledRows(query)

  if (amount === null || amount === undefined) return gateways

  return gateways.filter(
    ({ maxAmount, minAmount }) =>
      (minAmount === null || amount >= minAmount) && (maxAmount === null || amount <= maxAmount),
  )
}

/**
 * One gateway, for one order, ready to call — or the Persian reason it cannot be used.
 *
 * The reasons are deliberately coarse. This runs on a public checkout, and "the merchant id
 * is malformed" tells a caller that the platform holds a ZarinPal account for this shop and
 * that it is misconfigured. The specific reason goes to the log; the buyer gets a sentence
 * that is true and useless to an attacker.
 */
export const resolveGateway = async ({
  amount,
  currency,
  gateway,
  locale,
  req,
  siteId,
}: {
  amount?: null | number
  /**
   * The order's own snapshotted currency, not the site's current one: an order created
   * before a Rial→Toman switch is still a Rial order, and quoting the window in the wrong
   * unit would be a 10× error in the one check that exists to prevent 10× errors.
   */
  currency: CurrencyCode
  gateway: string
  locale?: TypedLocale
  req: PayloadRequest
  siteId: string
}): Promise<GatewayResolution> => {
  const refusal = (reason: string, detail: string): GatewayResolution => {
    req.payload.logger.warn({ msg: `payment gateway refused: ${detail}` })

    return { ok: false, reason }
  }

  if (!isGatewayId(gateway)) {
    return refusal('این روش پرداخت در این سایت فعال نیست.', `unknown gateway "${gateway}"`)
  }

  const moduleState = await paymentsModuleState(req)

  if (!moduleState.enabled) {
    return refusal('پرداخت آنلاین در حال حاضر غیرفعال است.', 'module disabled by the platform')
  }

  if (!moduleState.allowed.includes(gateway)) {
    return refusal('این روش پرداخت در این سایت فعال نیست.', `${gateway} is not allowlisted`)
  }

  /**
   * `overrideAccess: true` plus a context flag, not `showHiddenFields`. The flag is what the
   * collection's field hooks check before deciding whether to mask: `overrideAccess` alone
   * would also work today, but a flag only this module sets means a future change to field
   * access cannot silently start returning secrets to the admin UI.
   */
  req.context[SECRET_READ_CONTEXT_KEY] = true

  let row: null | PaymentGateway = null

  try {
    const { docs } = await req.payload.find({
      collection: 'payment-gateways',
      depth: 0,
      limit: 1,
      locale,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [{ site: { equals: siteId } }, { gateway: { equals: gateway } }],
      },
    })

    row = (docs[0] as PaymentGateway | undefined) ?? null
  } finally {
    delete req.context[SECRET_READ_CONTEXT_KEY]
  }

  if (!row) {
    return refusal('این روش پرداخت در این سایت فعال نیست.', `no ${gateway} row on site ${siteId}`)
  }

  if (!row.enabled) {
    return refusal('این روش پرداخت در این سایت فعال نیست.', `${gateway} row disabled on ${siteId}`)
  }

  const descriptor = gatewayDescriptor(gateway)
  const values = readSettings(row)
  const missing = missingCredentials(gateway, values)

  if (missing.length) {
    return refusal(
      'درگاه پرداخت این سایت به‌درستی پیکربندی نشده است.',
      `${gateway} row ${String(row.id)} is missing ${missing.join(', ')}`,
    )
  }

  /**
   * A row saved before encryption was wired up, or restored from a dump that bypassed the
   * hook, holds plaintext. It still works — `readSettings` passes a plaintext value through
   * — so this is a warning for an operator rather than a refusal for a buyer.
   */
  const stored = (row.credentials ?? {}) as Record<string, unknown>
  const plaintext = Object.entries(stored).filter(
    ([, value]) => typeof value === 'string' && value !== '' && !isEncrypted(value),
  )

  if (plaintext.length) {
    req.payload.logger.warn({
      msg: `payment gateway row ${String(row.id)} holds ${plaintext.length} unencrypted credential(s)`,
    })
  }

  if (amount !== null && amount !== undefined) {
    const { maxAmount, minAmount } = amountWindow(row, currency)

    if (minAmount !== null && amount < minAmount) {
      return refusal(
        'مبلغ این سفارش از حداقل مجاز این درگاه کمتر است.',
        `${gateway}: ${amount} below the ${minAmount} minimum on ${siteId}`,
      )
    }

    if (maxAmount !== null && amount > maxAmount) {
      return refusal(
        'مبلغ این سفارش از سقف مجاز این درگاه بیشتر است.',
        `${gateway}: ${amount} above the ${maxAmount} maximum on ${siteId}`,
      )
    }
  }

  const secretKeys = keysForGateway(gateway).filter((key) => isEncrypted(stored[key]))

  return {
    gateway: {
      adapter: gatewayAdapters[gateway],
      credentials: Object.fromEntries(
        Object.entries(values).filter(([key]) => secretKeys.includes(key)),
      ),
      descriptor,
      mode: (row.mode ?? 'live') as GatewayMode,
      rowId: String(row.id),
      settings: Object.fromEntries(
        Object.entries(values).filter(([key]) => !secretKeys.includes(key)),
      ),
    },
    ok: true,
  }
}

/**
 * The URL a gateway sends the buyer — and its own callback server — back to.
 *
 * Absolute and on the *site's* domain, because `siteOrigin` is the platform's one answer to
 * "which origin is this site on" (dev puts every domain on one port, production on none) and
 * because the `Host` of the callback is how the tenant is re-resolved: a callback arriving
 * on the control plane's host belongs to no site and is refused.
 *
 * Carries three query parameters:
 *
 * - `order` — the only client-supplied fact the callback uses, re-read scoped to the site;
 * - `gw` — which gateway opened it, so the endpoint can refuse a mismatch before it asks
 *   anything;
 * - `st` — `<issuedAt>.<hmac>` over `{ site, order, gateway, amount, issuedAt }`, valid for
 *   `PAYMENT_GATEWAY_STATE_TTL_MS`. Not a substitute for
 *   server-to-server verification, which is what actually decides `paid`; it is what stops a
 *   real callback URL being replayed against a different order or a different gateway, and
 *   it costs 22 characters.
 */
export const checkoutCallbackUrl = ({
  gateway,
  order,
  req,
}: {
  gateway: GatewayId
  order: CheckoutOrder
  req: PayloadRequest
}): string => {
  const origin = siteOrigin(order.site, req.origin)
  const state = signGatewayState({
    amount: order.total,
    gateway,
    orderId: order.id,
    siteId: String(order.site.id),
  })

  return `${origin}/api/checkout/callback?order=${encodeURIComponent(order.id)}&gw=${encodeURIComponent(
    gateway,
  )}&st=${encodeURIComponent(state)}`
}

/** Guard for the one path that takes an id from a URL. */
export const isGatewayRowId = (value: unknown): value is string => isUuid(value)

/**
 * One row, ready to be probed — for the admin's «self-test», not for a purchase.
 *
 * No order and no callback URL, because there is neither: this is a platform admin asking
 * "are the credentials I typed real?" before a buyer ever gets offered the gateway. That is
 * also why `healthCheck` takes `GatewayProbeContext` and not the full context — an adapter
 * whose probe demanded an order would have to be handed a fabricated one, and a fabricated
 * order is the sort of thing that later turns up in a PSP's settlement file.
 *
 * Reads the row under the internal secret flag, so the values are the real ciphertext.
 * The caller is responsible for authorisation: `POST /api/payments/self-test` checks
 * platform-admin before getting here, because a self-test is a request from this server to
 * a live merchant account and only the platform's own staff may cause one.
 */
export const probeContextFor = async ({
  req,
  rowId,
}: {
  req: PayloadRequest
  rowId: string
}): Promise<GatewayProbeContext> => {
  req.context[SECRET_READ_CONTEXT_KEY] = true

  let row: PaymentGateway

  try {
    row = (await req.payload.findByID({
      id: rowId,
      collection: 'payment-gateways',
      depth: 0,
      overrideAccess: true,
      req,
    })) as PaymentGateway
  } finally {
    delete req.context[SECRET_READ_CONTEXT_KEY]
  }

  const gateway = row.gateway as GatewayId

  if (!isGatewayId(gateway)) throw new Error(`probeContextFor: unknown gateway on row ${rowId}`)

  const descriptor = gatewayDescriptor(gateway)
  const secretKeys = descriptor.credentials.map(({ key }) => key)
  const values = readSettings(row)

  return {
    credentials: Object.fromEntries(
      Object.entries(values).filter(([key]) => secretKeys.includes(key)),
    ),
    descriptor,
    mode: (row.mode ?? 'live') as GatewayMode,
    req,
    rowId: String(row.id),
    settings: Object.fromEntries(
      Object.entries(values).filter(([key]) => !secretKeys.includes(key)),
    ),
  }
}
