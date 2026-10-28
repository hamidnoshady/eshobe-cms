import type { PayloadRequest, Where } from 'payload'

import { CDN_SECRET_READ_CONTEXT_KEY } from '@/collections/hooks/cdnZoneSecrets'

import { decryptCdnSecret } from './crypto'
import { CdnConfigurationError } from './service'
import type { CdnZoneInput } from './types'

type Raw = Record<string, unknown>

const relationId = (value: unknown): null | string => {
  if (typeof value === 'string' && value) return value
  if (value && typeof value === 'object' && typeof (value as Raw).id === 'string')
    return (value as Raw).id as string
  return null
}

/** The secret flag is set for exactly one read and removed in `finally`, so a later
 * read on the same `req` cannot inherit it. */
const withSecretRead = async <T>(req: PayloadRequest, read: () => Promise<T>): Promise<T> => {
  req.context[CDN_SECRET_READ_CONTEXT_KEY] = true
  try {
    return await read()
  } finally {
    delete req.context[CDN_SECRET_READ_CONTEXT_KEY]
  }
}

export const findCdnAccountWithSecret = async (
  req: PayloadRequest,
  id: string,
): Promise<null | Raw> =>
  withSecretRead(
    req,
    async () =>
      (await req.payload.findByID({
        id,
        collection: 'cdn-accounts',
        depth: 0,
        disableErrors: true,
        overrideAccess: true,
        req,
      })) as null | Raw,
  )

/**
 * The one place a zone's credentials are decided: the zone's own token if it has
 * one, otherwise the shared account it names. The account must be enabled and for
 * the same provider — a Cloudflare token sent to Arvan is a leak to the wrong
 * company, not merely a failed call.
 *
 * Returns the provider input with the ciphertext in place; decryption still happens
 * only inside `syncCdnZone` / `purgeCdnZone`, immediately before the request.
 */
export const withCdnCredentials = async (
  req: PayloadRequest,
  row: object,
): Promise<CdnZoneInput> => {
  const zone = row as Raw
  const input = { ...zone } as unknown as CdnZoneInput
  const own = (zone.credentials as Raw | undefined)?.apiToken
  if (typeof own === 'string' && decryptCdnSecret(own)) return input

  const accountId = relationId(zone.account)
  if (!accountId) return input

  const account = await findCdnAccountWithSecret(req, accountId)
  if (!account) throw new CdnConfigurationError('حساب CDN این zone یافت نشد.')
  if (account.enabled === false) throw new CdnConfigurationError('حساب CDN این zone غیرفعال است.')
  if (account.provider !== zone.provider)
    throw new CdnConfigurationError('ارائه‌دهندهٔ حساب CDN با zone یکی نیست.')

  return {
    ...input,
    arvanDomainMode: input.arvanDomainMode ?? (account.arvanDomainMode as 'full' | 'partial'),
    arvanPlanLevel: input.arvanPlanLevel || (account.arvanPlanLevel as null | string),
    cloudflareAccountId:
      input.cloudflareAccountId || (account.cloudflareAccountId as null | string),
    credentials: { apiToken: (account.credentials as Raw | undefined)?.apiToken as string },
  }
}

/** Read zone row(s) with the ciphertext visible, for a provider call only. */
export const findCdnZoneWithSecret = async (
  req: PayloadRequest,
  where: Where,
): Promise<null | Raw> =>
  withSecretRead(req, async () => {
    const found = await req.payload.find({
      collection: 'cdn-zones',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where,
    })
    return (found.docs[0] as unknown as Raw | undefined) ?? null
  })
