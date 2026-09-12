import type { CollectionBeforeChangeHook, FieldHook } from 'payload'

import {
  decryptPlatformSecret,
  encryptPlatformSecret,
  fingerprintPlatformSecret,
  generateWebhookSecret,
  isPlatformSecretEncrypted,
} from '@/lib/saas/crypto'

/**
 * Encrypt-on-write / mask-on-read for the control plane's own secrets.
 *
 * Identical in shape to `storageConnectionSecrets.ts` and `cdnZoneSecrets.ts`, and
 * worth restating because it is the part that is easy to get subtly wrong: **a
 * blank input on update means "unchanged", never "delete"**. The admin form masks
 * the field on read, so every unrelated save submits it empty — treating that as a
 * clear would wipe a working integration the first time somebody fixed a typo in
 * its name. The explicit door is the `clearCredential` checkbox.
 */

export const PLATFORM_SECRET_READ_CONTEXT_KEY = 'eshobePlatformSecretRead'

const MASK = '••••••••'

/** Blank a ciphertext on the way out, unless this is the resolver's own internal read. */
export const maskPlatformSecret =
  (): FieldHook =>
  ({ req, value }) => {
    if (req.context[PLATFORM_SECRET_READ_CONTEXT_KEY] === true) return value
    return value ? MASK : value
  }

const readStored = async (
  req: Parameters<CollectionBeforeChangeHook>[0]['req'],
  collection: 'plugins' | 'webhooks',
  id: string | undefined,
): Promise<Record<string, unknown>> => {
  if (!id) return {}
  req.context[PLATFORM_SECRET_READ_CONTEXT_KEY] = true
  try {
    const doc = await req.payload.findByID({
      collection,
      depth: 0,
      disableErrors: true,
      id,
      overrideAccess: true,
      req,
    })
    return (doc ?? {}) as Record<string, unknown>
  } finally {
    delete req.context[PLATFORM_SECRET_READ_CONTEXT_KEY]
  }
}

/**
 * `plugins.credential` — encrypted at rest, with a fingerprint so an operator can
 * tell "did my paste land?" without the value ever coming back.
 */
export const encryptPluginSettings: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const input = (data ?? {}) as { clearCredential?: unknown; credential?: unknown }
  const clear = input.clearCredential === true
  const typed = input.credential
  const stored = await readStored(req, 'plugins', originalDoc?.id as string | undefined)

  let credential = ''
  if (!clear && typeof typed === 'string' && typed.trim() && typed.trim() !== MASK) {
    credential = isPlatformSecretEncrypted(typed.trim()) ? typed.trim() : encryptPlatformSecret(typed.trim())
  } else if (!clear && typeof stored.credential === 'string') {
    credential = stored.credential
  }

  const plaintext = decryptPlatformSecret(credential)
  data.credential = credential
  data.clearCredential = false
  data.credentialsSummary = plaintext
    ? `کلید ذخیره شده · ${fingerprintPlatformSecret(plaintext)}`
    : 'کلیدی ذخیره نشده است.'

  return data
}

/**
 * `webhooks.secret` — same treatment, plus one difference that matters: a webhook
 * with no secret is **generated one at creation**.
 *
 * An unsigned webhook is not a lighter-weight webhook, it is an unauthenticated
 * POST into a customer's infrastructure that anybody who learns the URL can forge.
 * Making the secret optional would make the insecure configuration the default one,
 * reachable by leaving a field blank — so the field is optional in the *form* and
 * never optional in the *row*.
 */
export const encryptWebhookSecret: CollectionBeforeChangeHook = async ({ data, operation, originalDoc, req }) => {
  const input = (data ?? {}) as { clearSecret?: unknown; secret?: unknown }
  const clear = input.clearSecret === true
  const typed = input.secret
  const stored = await readStored(req, 'webhooks', originalDoc?.id as string | undefined)

  let secret = ''
  if (!clear && typeof typed === 'string' && typed.trim() && typed.trim() !== MASK) {
    secret = isPlatformSecretEncrypted(typed.trim()) ? typed.trim() : encryptPlatformSecret(typed.trim())
  } else if (!clear && typeof stored.secret === 'string') {
    secret = stored.secret
  }

  if (!secret && (operation === 'create' || clear)) {
    secret = encryptPlatformSecret(generateWebhookSecret())
  }

  const plaintext = decryptPlatformSecret(secret)
  data.secret = secret
  data.clearSecret = false
  data.secretSummary = plaintext
    ? `کلید امضا فعال · ${fingerprintPlatformSecret(plaintext)}`
    : 'کلید امضا ساخته نشده است.'

  return data
}

/** The one reader of a stored ciphertext, for both collections. Narrower than `overrideAccess` on purpose. */
export const readPlatformSecret = async (
  req: Parameters<CollectionBeforeChangeHook>[0]['req'],
  collection: 'plugins' | 'webhooks',
  id: string,
  field: 'credential' | 'secret',
): Promise<null | string> => {
  req.context[PLATFORM_SECRET_READ_CONTEXT_KEY] = true
  try {
    const doc = await req.payload.findByID({
      collection,
      depth: 0,
      disableErrors: true,
      id,
      overrideAccess: true,
      req,
    })
    return decryptPlatformSecret((doc as Record<string, unknown> | null)?.[field] as string | undefined)
  } finally {
    delete req.context[PLATFORM_SECRET_READ_CONTEXT_KEY]
  }
}
