import type { FieldHook, GlobalBeforeChangeHook } from 'payload'

import {
  decryptDomainResellerSecret,
  encryptDomainResellerSecret,
  fingerprintDomainResellerSecret,
  isDomainResellerSecretEncrypted,
} from '@/domain-reseller/crypto'

/** A narrower capability than `overrideAccess`: only the server-side adapter uses it. */
export const DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY = 'eshobeDomainResellerSecretRead'

type DomainResellerData = {
  clearCredentials?: unknown
  credentials?: { apiKey?: unknown }
  credentialsSummary?: unknown
}

/** Empty input in the global's form always means “keep the encrypted value”. */
export const encryptDomainResellerCredentials: GlobalBeforeChangeHook = async ({ data, req }) => {
  const input = (data ?? {}) as DomainResellerData
  let previous: unknown

  // Field hooks run before this hook sees the prior global, so `originalDoc` may already
  // be masked. Re-read it with the adapter-only capability; empty fields in the form must
  // preserve ciphertext rather than wiping the platform's registrar account.
  req.context[DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY] = true
  try {
    const stored = (await req.payload.findGlobal({
      slug: 'domain-reseller',
      depth: 0,
      overrideAccess: true,
      req,
    })) as DomainResellerData
    previous = stored.credentials?.apiKey
  } finally {
    delete req.context[DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY]
  }

  const typed = input.credentials?.apiKey
  const clear = input.clearCredentials === true
  let apiKey = ''

  if (!clear && typeof typed === 'string' && typed.trim()) {
    apiKey = isDomainResellerSecretEncrypted(typed.trim())
      ? typed.trim()
      : encryptDomainResellerSecret(typed.trim())
  } else if (!clear && typeof previous === 'string') {
    apiKey = previous
  }

  const plaintext = decryptDomainResellerSecret(apiKey)
  input.credentials = { apiKey }
  input.clearCredentials = false
  input.credentialsSummary = plaintext
    ? `API key configured · ${fingerprintDomainResellerSecret(plaintext)}`
    : 'No API key configured.'

  return input
}

/** The ciphertext is never present in REST, GraphQL, the global form, or an ordinary
 * Local API result. `overrideAccess` is intentionally not sufficient to reveal it. */
export const maskDomainResellerCredential =
  (): FieldHook =>
  ({ req, value }) =>
    req?.context?.[DOMAIN_RESELLER_SECRET_READ_CONTEXT_KEY] ? value : undefined
