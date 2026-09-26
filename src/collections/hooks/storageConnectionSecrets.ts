import type { CollectionBeforeChangeHook, FieldHook } from 'payload'

import { APIError } from 'payload'

import { decryptStorageSecret, encryptStorageSecret, fingerprintStorageSecret, isStorageSecretEncrypted } from '@/storage/crypto'

/**
 * What makes a `storage-connections` row safe to exist.
 *
 * Two jobs, in order:
 *
 * 1. **Encrypt the secret key.** The typed value never reaches Postgres. Blank on update
 *    means "unchanged", never "delete" — the admin form masks the field (see
 *    `maskStorageSecret`), so every unrelated save submits it empty; `clearCredentials` is
 *    the explicit door for wiping it.
 * 2. **One enabled connection.** The resolver (`src/storage/connection.ts`) reads "the
 *    enabled row"; two of them would make which bucket a tenant's file lands in depend on
 *    sort order at the moment it matters.
 */

export const STORAGE_SECRET_READ_CONTEXT_KEY = 'eshobeStorageSecretRead'

/** Allows self-test / scheduled health jobs to write derived health columns. */
export const STORAGE_HEALTH_WRITE_CONTEXT_KEY = 'eshobeStorageHealthWrite'

/** Patch object merged in `mergeContextStorageHealth` (after field access). */
export const STORAGE_HEALTH_PATCH_CONTEXT_KEY = 'eshobeStorageHealthPatch'

type StorageConnectionData = {
  clearCredentials?: unknown
  credentialsSummary?: unknown
  enabled?: unknown
  secretAccessKey?: unknown
}

const readStored = async (
  req: Parameters<CollectionBeforeChangeHook>[0]['req'],
  id: string | undefined,
): Promise<{ secretAccessKey?: string }> => {
  if (!id) return {}

  req.context[STORAGE_SECRET_READ_CONTEXT_KEY] = true
  try {
    const doc = await req.payload.findByID({
      collection: 'storage-connections',
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })
    return { secretAccessKey: (doc as { secretAccessKey?: string } | null)?.secretAccessKey }
  } finally {
    delete req.context[STORAGE_SECRET_READ_CONTEXT_KEY]
  }
}

export const encryptStorageCredentials: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const input = (data ?? {}) as StorageConnectionData
  const clear = input.clearCredentials === true
  const typed = input.secretAccessKey
  const stored = await readStored(req, originalDoc?.id as string | undefined)

  let secretAccessKey = ''
  if (!clear && typeof typed === 'string' && typed.trim()) {
    secretAccessKey = isStorageSecretEncrypted(typed.trim())
      ? typed.trim()
      : encryptStorageSecret(typed.trim())
  } else if (!clear && typeof stored.secretAccessKey === 'string') {
    secretAccessKey = stored.secretAccessKey
  }

  const plaintext = decryptStorageSecret(secretAccessKey)
  data.secretAccessKey = secretAccessKey
  data.clearCredentials = false
  data.credentialsSummary = plaintext
    ? `کلید ذخیره‌سازی پیکربندی شده · ${fingerprintStorageSecret(plaintext)}`
    : 'کلید ذخیره‌سازی وارد نشده است.'

  return data
}

/** Blank the secret on the way out, unless this is the resolver's own internal read. */
export const maskStorageSecret =
  (): FieldHook =>
  ({ req, value }) =>
    req?.context?.[STORAGE_SECRET_READ_CONTEXT_KEY] ? value : undefined

/** At most one enabled connection: the resolver reads "the enabled row", not "a list". */
export const assertSingleEnabledConnection: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const enabled = Boolean((data as StorageConnectionData)?.enabled ?? originalDoc?.enabled)
  if (!enabled) return data

  const selfId = originalDoc?.id as string | undefined

  const { totalDocs } = await req.payload.count({
    collection: 'storage-connections',
    overrideAccess: true,
    req,
    where: {
      and: [
        { enabled: { equals: true } },
        ...(selfId ? [{ id: { not_equals: selfId } }] : []),
      ],
    },
  })

  if (totalDocs > 0) {
    throw new APIError(
      'فقط یک اتصال ذخیره‌سازی می‌تواند فعال باشد. اتصال فعلی را غیرفعال کنید و این را فعال کنید.',
      400,
    )
  }

  return data
}

/**
 * Refuse to enable a connection that cannot actually be used.
 *
 * Runs after `encryptStorageCredentials`, so it inspects the same ciphertext that is about
 * to be written — checking the *typed* secret would pass a row the encrypting hook had just
 * refused to store. This is what turns "enabled with no key" into a save-time Persian error
 * instead of an upload-time failure for every customer.
 */
export const assertConnectionUsable: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  const enabled = Boolean((data as StorageConnectionData)?.enabled ?? originalDoc?.enabled)
  if (!enabled) return data

  const accessKeyId = String((data as { accessKeyId?: unknown }).accessKeyId ?? '')
  const secret = String((data as StorageConnectionData)?.secretAccessKey ?? '')

  if (!accessKeyId.trim()) {
    throw new APIError('برای فعال کردن اتصال، Access key لازم است.', 400)
  }

  if (!secret.trim() || !decryptStorageSecret(secret)) {
    throw new APIError('برای فعال کردن اتصال، Secret key معتبر لازم است.', 400)
  }

  return data
}
