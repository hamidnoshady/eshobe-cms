import type { CollectionBeforeChangeHook, FieldHook, PayloadRequest } from 'payload'

import {
  decryptDeploySecret,
  encryptDeploySecret,
  fingerprintDeploySecret,
  isDeploySecretEncrypted,
} from '@/lib/deploy/crypto'

/**
 * Encrypt-on-write / mask-on-read for the deployment surface's secrets.
 *
 * The same shape as `platformSecrets.ts`, `storageConnectionSecrets.ts` and the
 * gateway credentials, and restated for the same reason each of those restates it:
 * **a blank input on update means "unchanged", never "delete"**. The admin form
 * masks the field on read, so every unrelated save — renaming a target, ticking
 * `active` — submits it empty. Treating that as a clear wipes the operator's Coolify
 * token the first time somebody fixes a typo in the name, and the symptom is every
 * deploy on that server failing authentication an hour later. The explicit door is
 * `clearApiToken`.
 */

export const DEPLOY_SECRET_READ_CONTEXT_KEY = 'eshobeDeploySecretRead'

export const DEPLOY_SECRET_MASK = '••••••••'
const MASK = DEPLOY_SECRET_MASK

/** Blank a ciphertext on the way out, unless this is the deploy job's own internal read. */
export const maskDeploySecret =
  (): FieldHook =>
  ({ req, value }) => {
    if (req.context[DEPLOY_SECRET_READ_CONTEXT_KEY] === true) return value
    return value ? MASK : value
  }

const readStored = async (
  req: PayloadRequest,
  collection: 'deploy-targets' | 'site-theme-settings',
  id: string | undefined,
): Promise<Record<string, unknown>> => {
  if (!id) return {}
  req.context[DEPLOY_SECRET_READ_CONTEXT_KEY] = true
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
    delete req.context[DEPLOY_SECRET_READ_CONTEXT_KEY]
  }
}

/**
 * `deploy-targets.apiToken` — the deployment's most dangerous stored credential.
 *
 * The re-read is `findByID` with `overrideAccess` plus the context flag, **not**
 * `originalDoc`: the update operation's copy has already been through field access
 * and the masking hook, so merging against it would write the literal mask string
 * back into the column. That mistake is silent — the row saves, the fingerprint
 * changes, and every subsequent API call gets a 401.
 */
export const encryptDeployTargetToken: CollectionBeforeChangeHook = async ({
  data,
  originalDoc,
  req,
}) => {
  const input = (data ?? {}) as { apiToken?: unknown; clearApiToken?: unknown }
  const clear = input.clearApiToken === true
  const typed = input.apiToken
  const stored = await readStored(req, 'deploy-targets', originalDoc?.id as string | undefined)

  let token = ''
  if (!clear && typeof typed === 'string' && typed.trim() && typed.trim() !== MASK) {
    token = isDeploySecretEncrypted(typed.trim()) ? typed.trim() : encryptDeploySecret(typed.trim())
  } else if (!clear && typeof stored.apiToken === 'string') {
    token = stored.apiToken
  }

  const plaintext = decryptDeploySecret(token)
  data.apiToken = token
  data.clearApiToken = false
  data.tokenSummary = plaintext
    ? `توکن ذخیره شده · ${fingerprintDeploySecret(plaintext)}`
    : 'توکنی ذخیره نشده است.'

  // A token that changed invalidates what the last self-test proved. Leaving the
  // green tick in place would let an operator deploy against a credential nothing
  // has ever exercised.
  if (plaintext && stored.apiToken && stored.apiToken !== token) {
    data.lastSelfTestOk = false
    data.lastSelfTestDetail = 'توکن تغییر کرد؛ خودآزمایی را دوباره اجرا کنید.'
  }

  return data
}

/**
 * The one reader of a stored Coolify token. Narrower than `overrideAccess` on
 * purpose: `overrideAccess: true` is used all over this codebase for legitimate
 * reasons and bypasses field access entirely, so the context flag — which only this
 * function and `deployTargetById` set — is the actual boundary.
 */
export const readDeployTargetToken = async (
  req: PayloadRequest,
  id: string,
): Promise<null | string> => {
  req.context[DEPLOY_SECRET_READ_CONTEXT_KEY] = true
  try {
    const doc = await req.payload.findByID({
      collection: 'deploy-targets',
      depth: 0,
      disableErrors: true,
      id,
      overrideAccess: true,
      req,
    })
    return decryptDeploySecret((doc as Record<string, unknown> | null)?.apiToken as string | undefined)
  } finally {
    delete req.context[DEPLOY_SECRET_READ_CONTEXT_KEY]
  }
}

/**
 * `site-theme-settings.secretValues` — the tenant's secret answers to a manifest's
 * declared variables, encrypted as one blob.
 *
 * One encrypted JSON column rather than a column per variable, because the variable
 * set is defined by a third-party manifest and changes when the theme is synced. A
 * schema that a repository can alter is a migration that a repository can trigger.
 *
 * Blank, absent or the mask means **unchanged**: the update operation fills an
 * omitted field from its own copy of the document, which has been through the
 * masking hook, so the value arriving here on an unrelated save is the literal mask.
 * Encrypting that would replace every secret the customer entered with eight dots.
 * The stored value is re-read with the context flag instead. `null` is the explicit
 * clear; `saveTenantSettings` is the writer that decides per key.
 */
export const encryptThemeSettings: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const input = (data ?? {}) as { secretValues?: unknown }
  const raw = input.secretValues

  if (raw === null) return data

  if (raw === undefined || raw === '' || raw === MASK) {
    const stored = await readStored(req, 'site-theme-settings', originalDoc?.id as string | undefined)
    data.secretValues = typeof stored.secretValues === 'string' ? stored.secretValues : null
    return data
  }

  if (typeof raw === 'string') {
    data.secretValues = isDeploySecretEncrypted(raw) ? raw : encryptDeploySecret(raw)
    return data
  }

  data.secretValues = encryptDeploySecret(JSON.stringify(raw))
  return data
}

export const readThemeSettingSecrets = (value: unknown): Record<string, string> => {
  const plaintext = decryptDeploySecret(typeof value === 'string' ? value : null)
  if (!plaintext) return {}
  try {
    const parsed = JSON.parse(plaintext) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
    )
  } catch {
    return {}
  }
}
