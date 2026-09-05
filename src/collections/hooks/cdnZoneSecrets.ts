import type { CollectionBeforeChangeHook, FieldHook } from 'payload'

import { APIError } from 'payload'

import {
  decryptCdnSecret,
  encryptCdnSecret,
  fingerprintCdnSecret,
  isCdnSecretEncrypted,
} from '@/cdn/crypto'
import { normalizeDomain } from '@/lib/domains'

export const CDN_SECRET_READ_CONTEXT_KEY = 'eshobeCdnSecretRead'

type CredentialData = { apiToken?: unknown }
type CdnData = {
  clearCredentials?: unknown
  credentials?: CredentialData
  credentialsSummary?: unknown
  provider?: unknown
  providerZoneKey?: unknown
  zoneName?: unknown
}

const credentialsFor = async (
  args: Parameters<CollectionBeforeChangeHook>[0],
): Promise<CredentialData> => {
  if (args.operation !== 'update' || !args.originalDoc?.id) return {}
  args.req.context[CDN_SECRET_READ_CONTEXT_KEY] = true
  try {
    const stored = await args.req.payload.findByID({
      id: String(args.originalDoc.id),
      collection: 'cdn-zones',
      depth: 0,
      overrideAccess: true,
      req: args.req,
    })
    return ((stored as CdnData | null)?.credentials ?? {}) as CredentialData
  } finally {
    delete args.req.context[CDN_SECRET_READ_CONTEXT_KEY]
  }
}

/** Encrypt a typed token; an empty input deliberately preserves the stored token. */
export const encryptCdnCredentials: CollectionBeforeChangeHook = async (args) => {
  const data = (args.data ?? {}) as CdnData
  const stored = await credentialsFor(args)
  const clear = data.clearCredentials === true
  const typed = data.credentials?.apiToken
  const previous = stored.apiToken
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

  const provider = data.provider ?? args.originalDoc?.provider
  const zoneName =
    typeof data.zoneName === 'string' ? normalizeDomain(data.zoneName) : args.originalDoc?.zoneName
  if (typeof zoneName === 'string') data.zoneName = zoneName
  if (typeof provider === 'string' && typeof zoneName === 'string')
    data.providerZoneKey = `${provider}:${zoneName}`

  return data
}

export const maskCdnCredential =
  (): FieldHook =>
  ({ req, value }) =>
    req?.context?.[CDN_SECRET_READ_CONTEXT_KEY] ? value : undefined

/** A zone is an account-level resource. Sharing one between tenant records would
 * allow two administrators to write contradictory DNS and WAF state. */
export const uniqueCdnProviderZone: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const input = data as CdnData
  const providerZoneKey = input.providerZoneKey ?? originalDoc?.providerZoneKey
  if (typeof providerZoneKey !== 'string' || !providerZoneKey) return data

  const found = await req.payload.count({
    collection: 'cdn-zones',
    overrideAccess: true,
    req,
    where: {
      and: [
        { providerZoneKey: { equals: providerZoneKey } },
        ...(originalDoc?.id ? [{ id: { not_equals: String(originalDoc.id) } }] : []),
      ],
    },
  })

  if (found.totalDocs) {
    throw new APIError('این zone از قبل به سایت دیگری متصل است.', 400)
  }
  return data
}
