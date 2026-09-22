import { beforeAll, describe, expect, it } from 'vitest'

import {
  decryptDeploySecret,
  encryptDeploySecret,
  fingerprintDeploySecret,
  generateRevalidateSecret,
  isDeploySecretEncrypted,
} from '@/lib/deploy/crypto'
import { encryptPlatformSecret, decryptPlatformSecret } from '@/lib/saas/crypto'
import { readThemeSettingSecrets } from '@/collections/hooks/deploySecrets'

/**
 * The deployment surface's own crypto context.
 *
 * This is the fifth encryption module in the codebase, and the property worth a spec
 * is the one that justifies it being the fifth rather than a shared helper: **a key
 * from another domain must not decrypt these values.** A Coolify token can start and
 * stop every customer's storefront, so a credential leaked from the CDN or webhook
 * domain should buy an attacker nothing here.
 */

beforeAll(() => {
  // Both modules derive from `PAYLOAD_SECRET` when their own key is unset, which is
  // exactly the case where a shared derivation would be tempting — and exactly the
  // case the separate scrypt contexts have to survive.
  process.env.PAYLOAD_SECRET ??= 'test-secret-for-deploy-crypto'
})

describe('deploy secret crypto', () => {
  it('round-trips a value and tags it with the versioned prefix', () => {
    const sealed = encryptDeploySecret('coolify_token_abc')

    expect(isDeploySecretEncrypted(sealed)).toBe(true)
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    expect(sealed).not.toContain('coolify_token_abc')
    expect(decryptDeploySecret(sealed)).toBe('coolify_token_abc')
  })

  it('never double-encrypts, so a hook re-running is harmless', () => {
    const once = encryptDeploySecret('token')

    expect(encryptDeploySecret(once)).toBe(once)
  })

  it('produces a different ciphertext each time — the IV is not reused', () => {
    expect(encryptDeploySecret('token')).not.toBe(encryptDeploySecret('token'))
  })

  it('does not decrypt a value sealed by the platform context, and vice versa', () => {
    // The reason this module exists. Same `PAYLOAD_SECRET`, different scrypt context,
    // so a database dump from one domain does not unlock the other.
    const platformSealed = encryptPlatformSecret('shared-plaintext')
    const deploySealed = encryptDeploySecret('shared-plaintext')

    expect(decryptDeploySecret(platformSealed)).toBeNull()
    expect(decryptPlatformSecret(deploySealed)).toBeNull()
  })

  it('reads a tampered or truncated ciphertext as "not usable" rather than throwing', () => {
    // GCM's auth tag is what makes this detectable; answering `null` is what keeps a
    // corrupted row from turning into a 500 inside a deploy.
    const sealed = encryptDeploySecret('token')
    const tampered = `${sealed.slice(0, -4)}AAAA`

    expect(decryptDeploySecret(tampered)).toBeNull()
    expect(decryptDeploySecret('enc:v1:short')).toBeNull()
    expect(decryptDeploySecret(null)).toBeNull()
    expect(decryptDeploySecret('')).toBeNull()
  })

  it('fingerprints stably and distinctly, so an operator can tell "did my paste land?"', () => {
    expect(fingerprintDeploySecret('a')).toBe(fingerprintDeploySecret('a'))
    expect(fingerprintDeploySecret('a')).not.toBe(fingerprintDeploySecret('b'))
    // Short enough to be a display string, never enough to be a credential.
    expect(fingerprintDeploySecret('a')).toHaveLength(12)
  })

  it('mints a distinct revalidation secret per call', () => {
    // Per deployment, never global: one shared secret across twenty storefronts means
    // any theme author who reads their own env can forge a purge at every other one.
    const a = generateRevalidateSecret()
    const b = generateRevalidateSecret()

    expect(a).not.toBe(b)
    expect(a.startsWith('esrv_')).toBe(true)
  })
})

describe('theme setting secrets', () => {
  it('decrypts a stored blob back into a flat map', () => {
    const sealed = encryptDeploySecret(JSON.stringify({ MAP_API_KEY: 'abc' }))

    expect(readThemeSettingSecrets(sealed)).toEqual({ MAP_API_KEY: 'abc' })
  })

  it('answers an empty map for anything unreadable, never a throw', () => {
    // A value that no longer decrypts reads as "not configured" — the deploy then
    // fails on a missing required variable with a Persian reason, rather than
    // exploding inside an HTTP call.
    expect(readThemeSettingSecrets(null)).toEqual({})
    expect(readThemeSettingSecrets(encryptDeploySecret('not json'))).toEqual({})
    expect(readThemeSettingSecrets(encryptDeploySecret('[1,2]'))).toEqual({})
    expect(readThemeSettingSecrets('plaintext')).toEqual({})
  })
})
