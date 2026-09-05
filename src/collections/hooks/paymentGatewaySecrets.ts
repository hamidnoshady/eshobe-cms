import type { CollectionBeforeChangeHook, FieldHook } from 'payload'

import { APIError } from 'payload'

import type { GatewayId } from '@/payments/gateways/types'
import type { PaymentGateway } from '@/payload-types'

import { idOf } from '@/lib/ids'

import { SECRET_READ_CONTEXT_KEY, paymentsModuleState } from '@/payments/gateways/resolve'
import { encryptSecret, fingerprintSecret, isEncrypted } from '@/payments/gateways/crypto'
import { gatewayDescriptor, isGatewayId, keysForGateway, missingCredentials } from '@/payments/gateways/registry'
import { decryptSecret } from '@/payments/gateways/crypto'

/**
 * Everything that makes a `payment-gateways` row safe to exist.
 *
 * Four jobs, in the order they run:
 *
 * 1. **Encrypt.** The typed value never reaches Postgres. The hook merges what was typed
 *    over what is already stored, so saving an unrelated field cannot wipe a merchant's
 *    `client_secret` — the admin form shows these fields empty (see `maskCredential`), which
 *    means every save submits them empty, which means "blank" has to read as "unchanged" and
 *    not as "delete".
 * 2. **Lock the gateway.** A row's `gateway` decides which adapter runs and which columns
 *    its ciphertext lives in. Changing it would leave ZarinPal's `merchant_id` decrypting
 *    into Digipay's `username`, so an existing row cannot change provider — create a second
 *    row instead.
 * 3. **One row per (site, gateway).** Two ZarinPal rows on one site would make "the
 *    gateway this site uses" ambiguous at exactly the moment it matters: `resolveGateway`
 *    reads one row, and which one it reads would depend on sort order.
 * 4. **Refuse an unusable `enabled: true`.** The switch is the tenant's, but switching
 *    something on that cannot work is a broken storefront, not a preference: no credentials,
 *    a currency the provider does not settle in, or a gateway the platform has not
 *    allowlisted. The tenant gets a Persian sentence naming the problem, at save time,
 *    rather than a buyer getting a 503 at checkout.
 */

type CredentialValues = Record<string, unknown>

/**
 * Read the stored ciphertext for a row, unmasked.
 *
 * Not `originalDoc`: the update operation's copy of the document has been through field
 * access and the masking hook below, so its credential values are whatever the caller was
 * allowed to see. Re-reading under the internal flag is one extra query on a document that
 * is saved a handful of times a year, and it is the only way to merge correctly.
 */
const storedCredentials = async (
  req: Parameters<CollectionBeforeChangeHook>[0]['req'],
  id: null | string | undefined,
): Promise<CredentialValues> => {
  if (!id) return {}

  req.context[SECRET_READ_CONTEXT_KEY] = true

  try {
    // No `disableErrors: true` here, which is the opposite of the usual instinct. If this
    // read fails and resolves to nothing instead of throwing, the merge below sees "no
    // stored credentials", writes an empty value for every key the admin did not retype —
    // and silently wipes a merchant's client_secret on an unrelated save. A save that
    // aborts is recoverable; a wiped credential is not, because nobody can read the old
    // value back to restore it.
    const doc = await req.payload.findByID({
      id,
      collection: 'payment-gateways',
      depth: 0,
      overrideAccess: true,
      req,
    })

    return ((doc as null | PaymentGateway)?.credentials ?? {}) as CredentialValues
  } finally {
    delete req.context[SECRET_READ_CONTEXT_KEY]
  }
}

/** Which keys hold something, in Persian, for the summary the admin can actually read. */
const summarise = (gateway: GatewayId, values: CredentialValues): string => {
  const keys = keysForGateway(gateway)
  const set = keys.filter((key) => {
    const value = values[key]

    return typeof value === 'string' && value !== ''
  })

  if (!set.length) return 'هیچ اعتبارنامه‌ای وارد نشده است.'

  // A fingerprint, not the value: the admin cannot read a secret back by design, so it
  // needs *something* that changes when the secret does. 48 bits over a value nobody can
  // enumerate is not a guess, and it is what makes "did that save?" answerable.
  const fingerprinted = set
    .filter((key) => gatewayDescriptor(gateway).credentials.some(({ key: k }) => k === key))
    .map((key) => {
      const plain = decryptSecret(String(values[key])) ?? String(values[key])

      return `${key}:${fingerprintSecret(plain)}`
    })

  return `${set.length} فیلد وارد شده${fingerprinted.length ? ` · ${fingerprinted.join(' ')}` : ''}`
}

export const encryptGatewayCredentials: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const gateway = (data?.gateway ?? originalDoc?.gateway) as GatewayId

  if (!isGatewayId(gateway)) return data

  const incoming = (data?.credentials ?? {}) as CredentialValues
  const clear = data?.clearCredentials === true
  // `beforeChange` is not handed an `id` — the document being updated is `originalDoc`, and
  // its id is the row whose ciphertext has to be merged back in.
  const existing =
    operation === 'update' ? await storedCredentials(req, idOf(originalDoc?.id)) : {}

  const next: CredentialValues = {}
  let changed = clear && Object.keys(existing).length > 0

  for (const key of keysForGateway(gateway)) {
    if (clear) {
      next[key] = ''
      continue
    }

    const typed = incoming[key]
    const stored = existing[key]

    if (typeof typed !== 'string' || !typed.trim()) {
      // Blank means "unchanged", never "delete" — see the module comment. `clearCredentials`
      // is the explicit door for wiping a row.
      next[key] = typeof stored === 'string' ? stored : ''
      continue
    }

    const trimmed = typed.trim()

    next[key] = isEncrypted(trimmed) ? trimmed : encryptSecret(trimmed)

    if (next[key] !== stored) changed = true
  }

  data.credentials = next
  data.clearCredentials = false
  data.credentialsSummary = summarise(gateway, next)
  // The admin list's title. Derived, not typed: a row named by hand drifts from the gateway
  // it configures, and `useAsTitle` on a select would show the raw enum value.
  data.title = `${gatewayDescriptor(gateway).label}${
    typeof data.displayName === 'string' && data.displayName.trim() ? ` — ${data.displayName.trim()}` : ''
  }`
  data.credentialsUpdatedAt = changed
    ? new Date().toISOString()
    : ((originalDoc?.credentialsUpdatedAt as null | string | undefined) ?? undefined)

  return data
}

/**
 * Blank a credential field on the way out, unless this is the module's own internal read.
 *
 * A factory so each generated field gets its own hook instance. The discriminator is a
 * request-context flag that only `src/payments/gateways/resolve.ts` sets, not
 * `overrideAccess`: `overrideAccess` is true for plenty of reads that must not see a
 * merchant's password, and a flag nobody else can set cannot be widened by a future change
 * to field access.
 */
export const maskCredential =
  (): FieldHook =>
  ({ req, value }) =>
    req?.context?.[SECRET_READ_CONTEXT_KEY] ? value : undefined

export const lockGatewayChoice: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  operation,
}) => {
  if (operation !== 'update') return data

  const previous = originalDoc?.gateway
  const next = data?.gateway

  if (previous && next && previous !== next) {
    throw new APIError(
      'درگاه یک ردیف قابل تغییر نیست؛ یک ردیف جدید برای درگاه دیگر بسازید. ' +
        'تغییر آن، اعتبارنامهٔ رمزنگاری‌شدهٔ درگاه قبلی را به درگاه جدید نسبت می‌دهد.',
      400,
    )
  }

  return data
}

export const uniqueGatewayPerSite: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const gateway = (data?.gateway ?? originalDoc?.gateway) as GatewayId | undefined
  const siteId = idOf(data?.site) ?? idOf(originalDoc?.site)

  if (!isGatewayId(gateway) || !siteId) return data

  const selfId = idOf(originalDoc?.id)

  const { totalDocs } = await req.payload.count({
    collection: 'payment-gateways',
    overrideAccess: true,
    req,
    where: {
      and: [
        { gateway: { equals: gateway } },
        { site: { equals: siteId } },
        ...(selfId ? [{ id: { not_equals: selfId } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    throw new APIError(
      `این سایت هم‌اکنون یک ردیف «${gatewayDescriptor(gateway).label}» دارد. ` +
        'برای هر سایت و هر درگاه فقط یک ردیف وجود دارد.',
      400,
    )
  }

  return data
}

/**
 * Refuse to switch on a gateway that cannot take money.
 *
 * Runs last, after `encryptGatewayCredentials`, so it inspects the same ciphertext that is
 * about to be written — checking the *typed* values would pass a row whose secrets the
 * encrypting hook had just refused to store.
 */
export const assertGatewayUsable: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const enabled = Boolean(data?.enabled ?? originalDoc?.enabled)

  if (!enabled) return data

  const gateway = (data?.gateway ?? originalDoc?.gateway) as GatewayId

  if (!isGatewayId(gateway)) {
    throw new APIError('درگاه را انتخاب کنید.', 400)
  }

  const siteId = idOf(data?.site) ?? idOf(originalDoc?.site)

  if (!siteId) {
    // Not a validation nicety. A row with no tenant is a row the multi-tenant plugin cannot
    // scope, which on this platform is the shape of every leak `CLAUDE.md` warns about.
    throw new APIError('ردیف درگاه باید به یک سایت اختصاص یابد.', 400)
  }

  const moduleState = await paymentsModuleState(req)

  if (!moduleState.enabled) {
    throw new APIError(
      'ماژول درگاه‌های پرداخت در سطح سکو غیرفعال است؛ ابتدا از «تنظیمات پرداخت» آن را فعال کنید.',
      400,
    )
  }

  if (!moduleState.allowed.includes(gateway)) {
    throw new APIError(
      `«${gatewayDescriptor(gateway).label}» در فهرست درگاه‌های مجاز سکو نیست.`,
      400,
    )
  }

  const descriptor = gatewayDescriptor(gateway)

  // The site's currency, from its own `store` singleton. An Iranian PSP settles in Rial or
  // Toman, and a USD store switching one on would discover that on a buyer's checkout.
  const { docs } = await req.payload.find({
    collection: 'store',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    select: { currency: true },
    where: { site: { equals: siteId } },
  })

  const currency = (docs[0] as { currency?: string } | undefined)?.currency ?? 'IRT'

  if (!descriptor.currencies.includes(currency as (typeof descriptor.currencies)[number])) {
    throw new APIError(
      `واحد پول این سایت «${currency}» است و ${descriptor.label} فقط با ${descriptor.currencies
        .map((code) => (code === 'IRT' ? 'تومان' : 'ریال'))
        .join(' یا ')} کار می‌کند.`,
      400,
    )
  }

  const values = (data?.credentials ?? originalDoc?.credentials ?? {}) as CredentialValues
  const plain = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => typeof value === 'string' && value !== '')
      .map(([key, value]) => [
        key,
        isEncrypted(value) ? (decryptSecret(String(value)) ?? '') : String(value),
      ]),
  )

  const missing = missingCredentials(gateway, plain)

  if (missing.length) {
    throw new APIError(
      `برای فعال کردن ${descriptor.label} این موارد لازم است: ${missing.join('، ')}.`,
      400,
    )
  }

  const minAmount = data?.minAmount ?? originalDoc?.minAmount
  const maxAmount = data?.maxAmount ?? originalDoc?.maxAmount

  if (
    typeof minAmount === 'number' &&
    typeof maxAmount === 'number' &&
    minAmount > 0 &&
    maxAmount > 0 &&
    minAmount > maxAmount
  ) {
    throw new APIError('حداقل مبلغ نمی‌تواند از حداکثر بیشتر باشد.', 400)
  }

  return data
}
