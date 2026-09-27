import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { normalizeArtifactRegistration, verifyArtifactSignature } from '@/deploy/artifacts'

const commit = 'a'.repeat(40)
const digest = `sha256:${'b'.repeat(64)}`
const pkg = { repository: 'owner/theme', registryImageRepository: 'ghcr.io/owner/theme' }
const body = {
  repository: 'owner/theme',
  ref: 'main',
  commit,
  registry: 'ghcr',
  image: 'ghcr.io/owner/theme',
  digest,
}

describe('theme artifact registration validation', () => {
  it('normalizes a package-bound immutable GHCR image', () => {
    expect(normalizeArtifactRegistration(pkg, body)).toMatchObject({
      ok: true,
      value: { commit, digest, image: 'ghcr.io/owner/theme' },
    })
  })
  it.each([
    [{ ...body, digest: 'sha256:bad' }, 'digest'],
    [{ ...body, image: 'ghcr.io/attacker/image' }, 'مخزن تصویر'],
    [{ ...body, repository: 'other/theme' }, 'مخزن callback'],
    [{ ...body, commit: 'main' }, 'کامیت'],
    [{ ...body, workflowRunUrl: 'http://169.254.169.254/latest' }, 'workflow'],
  ])('rejects untrusted registration %#', (input, message) => {
    const result = normalizeArtifactRegistration(pkg, input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(message)
  })
  it('verifies the exact raw callback body with timing-safe HMAC', () => {
    const raw = JSON.stringify(body)
    const signature = `sha256=${createHmac('sha256', 'secret').update(raw).digest('hex')}`
    expect(verifyArtifactSignature('secret', raw, signature)).toBe(true)
    expect(verifyArtifactSignature('secret', `${raw} `, signature)).toBe(false)
  })
})
