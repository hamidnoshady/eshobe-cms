import type { CollectionBeforeChangeHook, FieldHook, PayloadRequest } from 'payload'

import {
  decryptPlatformSecret,
  encryptPlatformSecret,
  isPlatformSecretEncrypted,
} from '@/lib/saas/crypto'

/**
 * WordPress/WooCommerce connector secrets (issue #166).
 *
 * A source row holds credentials capable of reading another system's orders
 * and customers, so the rule is the platform's usual one: encrypt on write,
 * mask on ordinary reads, and let exactly one internal reader decrypt them
 * for the duration of one connector construction. The values themselves are
 * never put in events, errors, job settings or API responses.
 */
export const MIGRATION_SECRET_READ_CONTEXT_KEY = 'eshobeMigrationSecretRead'

const MASK = '••••••••'

export const MIGRATION_SECRET_FIELDS = [
  'wpApplicationPassword',
  'wooConsumerKey',
  'wooConsumerSecret',
] as const

export type MigrationSecretField = (typeof MIGRATION_SECRET_FIELDS)[number]

export const maskMigrationSecret =
  (): FieldHook =>
  ({ req, value }) => {
    if (req.context[MIGRATION_SECRET_READ_CONTEXT_KEY] === true) return value
    return value ? MASK : value
  }

/** Encrypt any plaintext secret a write carries; untouched fields stay untouched. */
export const encryptMigrationSecrets: CollectionBeforeChangeHook = ({ data }) => {
  const row = data as Record<string, unknown>

  for (const field of MIGRATION_SECRET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue
    const value = row[field]

    if (typeof value !== 'string' || !value.trim() || value.trim() === MASK) {
      row[field] = value === MASK ? undefined : value
      continue
    }

    row[field] = isPlatformSecretEncrypted(value.trim())
      ? value.trim()
      : encryptPlatformSecret(value.trim())
  }

  return data
}

export type MigrationSourceSecrets = {
  wooConsumerKey: null | string
  wooConsumerSecret: null | string
  wpApplicationPassword: null | string
}

/** The one reader allowed to turn a stored connector ciphertext back into a client credential. */
export const readMigrationSourceSecrets = async (
  req: PayloadRequest,
  sourceId: string,
): Promise<MigrationSourceSecrets> => {
  req.context[MIGRATION_SECRET_READ_CONTEXT_KEY] = true

  try {
    const doc = (await req.payload.findByID({
      collection: 'migration-sources',
      depth: 0,
      disableErrors: true,
      id: sourceId,
      overrideAccess: true,
      req,
    })) as null | Record<string, unknown>

    return {
      wooConsumerKey: decryptPlatformSecret(doc?.wooConsumerKey as string | undefined),
      wooConsumerSecret: decryptPlatformSecret(doc?.wooConsumerSecret as string | undefined),
      wpApplicationPassword: decryptPlatformSecret(
        doc?.wpApplicationPassword as string | undefined,
      ),
    }
  } finally {
    delete req.context[MIGRATION_SECRET_READ_CONTEXT_KEY]
  }
}
