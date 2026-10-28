import type { CollectionBeforeChangeHook, CollectionBeforeDeleteHook, Validate } from 'payload'

import { APIError } from 'payload'

import {
  decryptCdnSecret,
  encryptCdnSecret,
  fingerprintCdnSecret,
  isCdnSecretEncrypted,
} from '@/cdn/crypto'
import { isValidDomain, normalizeDomain } from '@/lib/domains'

import { CDN_SECRET_READ_CONTEXT_KEY } from './cdnZoneSecrets'

type AccountData = {
  arvanDomainMode?: unknown
  clearCredentials?: unknown
  cloudflareAccountId?: unknown
  credentials?: { apiToken?: unknown }
  credentialsSummary?: unknown
  enabled?: unknown
  originTarget?: unknown
  provider?: unknown
  tenantSelfService?: unknown
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
// Structural only: the provider is the authority on IPv6 syntax, and this field is
// operator input. What matters here is that a value is unmistakably *an address*.
const IPV6 = /^[0-9a-f:]+(?::\d{1,3}(?:\.\d{1,3}){3})?$/i

export type OriginKind = 'A' | 'AAAA' | 'CNAME'

/** Which record type points a hostname at this origin, or null for garbage. */
export const originRecordType = (value: unknown): OriginKind | null => {
  if (typeof value !== 'string' || !value.trim()) return null
  const target = value.trim()
  if (IPV4.test(target)) return 'A'
  if (target.includes(':') && IPV6.test(target)) return 'AAAA'
  return isValidDomain(target) ? 'CNAME' : null
}

export const validateOriginTarget: Validate = (value) =>
  value === null || value === undefined || value === '' || originRecordType(value)
    ? true
    : 'یک IPv4، IPv6 یا hostname معتبر وارد کنید.'

/** A token is only valid for the provider it was issued by; a changed provider
 * would attribute one company's secret to another's API. */
export const keepCdnAccountProvider: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
}) => {
  if (operation === 'update' && originalDoc?.provider && data.provider !== undefined) {
    if (data.provider !== originalDoc.provider)
      throw new APIError('ارائه‌دهندهٔ حساب CDN پس از ساخت قابل تغییر نیست.', 400)
  }
  return data
}

/** Same rules as `encryptCdnCredentials` on a zone: blank means unchanged, the
 * stored ciphertext is re-read with the secret flag rather than taken from
 * `originalDoc` (which has already been masked). */
export const encryptCdnAccountCredentials: CollectionBeforeChangeHook = async (args) => {
  const data = (args.data ?? {}) as AccountData
  let previous: unknown
  if (args.operation === 'update' && args.originalDoc?.id) {
    args.req.context[CDN_SECRET_READ_CONTEXT_KEY] = true
    try {
      const stored = await args.req.payload.findByID({
        id: String(args.originalDoc.id),
        collection: 'cdn-accounts',
        depth: 0,
        overrideAccess: true,
        req: args.req,
      })
      previous = (stored as AccountData | null)?.credentials?.apiToken
    } finally {
      delete args.req.context[CDN_SECRET_READ_CONTEXT_KEY]
    }
  }

  const clear = data.clearCredentials === true
  const typed = data.credentials?.apiToken
  let apiToken = ''
  if (!clear && typeof typed === 'string' && typed.trim()) {
    apiToken = isCdnSecretEncrypted(typed.trim()) ? typed.trim() : encryptCdnSecret(typed.trim())
  } else if (!clear && typeof previous === 'string') {
    apiToken = previous
  }

  const plaintext = decryptCdnSecret(apiToken)
  data.credentials = { apiToken }
  data.clearCredentials = false
  data.credentialsSummary = plaintext
    ? `API token configured · ${fingerprintCdnSecret(plaintext)}`
    : 'No API token configured.'
  if (typeof data.originTarget === 'string') data.originTarget = normalizeDomain(data.originTarget)
  return data
}

/**
 * Self-service is the switch that lets a *tenant* spend this account, so it is
 * refused until the account can actually serve the request it promises: a token
 * that decrypts, an origin the template can point at, and for Cloudflare the
 * account id zone creation needs. Arvan's template writes the zone apex, which
 * cannot be a CNAME there, so its origin must be an address.
 */
export const assertCdnAccountUsable: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  const merged = { ...(originalDoc ?? {}), ...data } as AccountData
  if (merged.tenantSelfService !== true) return data
  if (merged.enabled === false)
    throw new APIError('حساب غیرفعال نمی‌تواند سلف‌سرویس مشتری داشته باشد.', 400)
  if (!decryptCdnSecret(merged.credentials?.apiToken as string | undefined))
    throw new APIError('برای فعال کردن سلف‌سرویس، توکن قابل استفاده لازم است.', 400)
  const origin = originRecordType(merged.originTarget)
  if (!origin) throw new APIError('برای سلف‌سرویس، مقصد origin لازم است.', 400)
  if (merged.provider === 'arvancloud' && origin === 'CNAME')
    throw new APIError(
      'در ArvanCloud مقصد origin باید IP باشد (رکورد ریشهٔ دامنه CNAME نمی‌پذیرد).',
      400,
    )
  if (
    merged.provider === 'cloudflare' &&
    !(typeof merged.cloudflareAccountId === 'string' && merged.cloudflareAccountId.trim())
  )
    throw new APIError('برای سلف‌سرویس Cloudflare، Account ID لازم است.', 400)
  return data
}

/** The tenant endpoint resolves "the" self-service account per provider; two would
 * make that choice arbitrary. */
export const singleSelfServiceAccountPerProvider: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const merged = { ...(originalDoc ?? {}), ...data } as AccountData
  if (merged.tenantSelfService !== true) return data
  const { totalDocs } = await req.payload.count({
    collection: 'cdn-accounts',
    overrideAccess: true,
    req,
    where: {
      and: [
        { provider: { equals: merged.provider } },
        { tenantSelfService: { equals: true } },
        ...(originalDoc?.id ? [{ id: { not_equals: String(originalDoc.id) } }] : []),
      ],
    },
  })
  if (totalDocs) throw new APIError('برای این ارائه‌دهنده حساب سلف‌سرویس دیگری فعال است.', 400)
  return data
}

/** A zone that names this account would silently lose its credentials. */
export const refuseDeleteReferencedCdnAccount: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { totalDocs } = await req.payload.count({
    collection: 'cdn-zones',
    overrideAccess: true,
    req,
    where: { account: { equals: id } },
  })
  if (totalDocs)
    throw new APIError(
      `${totalDocs} zone هنوز از این حساب استفاده می‌کند؛ ابتدا آن‌ها را جدا کنید.`,
      409,
    )
}
