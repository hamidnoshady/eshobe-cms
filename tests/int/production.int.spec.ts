import { beforeEach, describe, expect, it, vi } from 'vitest'

import { setMediaPrefix, sitePrefix } from '@/hooks/mediaPrefix'
import { tryRevalidate } from '@/hooks/revalidate'
import { jobsAutoRunEnabled, productionEnvProblems, shouldCheckEnv } from '@/lib/env'
import { r2Configured, r2Endpoint } from '@/plugins/storage'

/**
 * Wave 6's production posture: where files land, whether the queue runs, and
 * whether this environment is allowed to serve traffic at all.
 */

const run = (args: unknown) =>
  (setMediaPrefix as (a: unknown) => Record<string, unknown>)(args) as Record<string, unknown>

describe('per-site media prefix', () => {
  it('namespaces a new upload by its site', () => {
    // Two tenants both upload `logo.png`. Without the prefix they are one object in
    // one bucket, and the second overwrites the first.
    expect(run({ data: { site: 'site-a' } })).toEqual({
      prefix: 'sites/site-a/media',
      site: 'site-a',
    })
    expect(sitePrefix('site-a')).toBe('sites/site-a/media')
  })

  it('accepts a populated site relationship as well as an ID', () => {
    expect(run({ data: { site: { id: 'site-b' } } }).prefix).toBe('sites/site-b/media')
  })

  it('never rewrites the prefix of an existing document', () => {
    // The object already sits at the old key. Re-deriving the prefix would point the
    // record at a key that does not exist and orphan the real file on delete.
    const result = run({
      data: { site: 'site-b' },
      originalDoc: { prefix: 'sites/site-a/media', site: 'site-a' },
    })

    expect(result.prefix).toBe('sites/site-a/media')
  })

  it('writes nothing at the bucket root when there is no site', () => {
    expect(run({ data: { alt: 'x' } })).toEqual({ alt: 'x' })
  })
})

describe('R2 configuration', () => {
  const full = {
    R2_ACCESS_KEY_ID: 'key',
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET: 'bucket',
    R2_SECRET_ACCESS_KEY: 'secret',
  }

  it('treats a partial credential set as not configured', () => {
    // The dangerous middle state: the adapter takes over the media collection and
    // then fails on every single upload.
    expect(r2Configured(full)).toBe(true)
    expect(r2Configured({ ...full, R2_SECRET_ACCESS_KEY: undefined })).toBe(false)
    expect(r2Configured({})).toBe(false)
  })

  it('derives the account endpoint, and lets it be overridden', () => {
    expect(r2Endpoint(full)).toBe('https://acct.r2.cloudflarestorage.com')
    expect(r2Endpoint({ ...full, R2_ENDPOINT: 'https://cdn.example.com' })).toBe(
      'https://cdn.example.com',
    )
  })
})

describe('production environment guard', () => {
  const safe = {
    CRON_SECRET: 'a'.repeat(24),
    NEXT_PUBLIC_SERVER_URL: 'https://admin.example.com',
    NODE_ENV: 'production',
    PAYLOAD_SECRET: 'b'.repeat(48),
    PREVIEW_SECRET: 'c'.repeat(24),
  }

  it('passes a properly configured production environment', () => {
    expect(productionEnvProblems(safe)).toEqual([])
  })

  it('rejects the example placeholders and short secrets', () => {
    expect(productionEnvProblems({ ...safe, PAYLOAD_SECRET: 'YOUR_SECRET_HERE' })).toEqual([
      'PAYLOAD_SECRET is still the example placeholder.',
    ])
    expect(productionEnvProblems({ ...safe, PAYLOAD_SECRET: 'short' })).toEqual([
      'PAYLOAD_SECRET is shorter than 32 characters.',
    ])
    expect(productionEnvProblems({ ...safe, CRON_SECRET: undefined })).toEqual([
      'CRON_SECRET is not set.',
    ])
    expect(
      productionEnvProblems({ ...safe, NEXT_PUBLIC_SERVER_URL: 'http://admin.example.com' }),
    ).toEqual(['NEXT_PUBLIC_SERVER_URL is not an https:// URL.'])
  })

  it('stands down during the production build', () => {
    // The Dockerfile builds with a dummy secret and no database on purpose; failing
    // the image build is not what this guard is for.
    expect(shouldCheckEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(shouldCheckEnv({ NEXT_PHASE: 'phase-production-build', NODE_ENV: 'production' })).toBe(
      false,
    )
    expect(shouldCheckEnv({ NODE_ENV: 'development' })).toBe(false)
  })
})

describe('jobs autoRun', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('runs the queue in production and stays out of dev and tests', () => {
    expect(jobsAutoRunEnabled({ NODE_ENV: 'production' })).toBe(true)
    expect(jobsAutoRunEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(jobsAutoRunEnabled({ NODE_ENV: 'test' })).toBe(false)
  })

  it('can be forced off in production — the multi-replica upgrade path', () => {
    // Two web replicas both run the same cron against the same queue, and every
    // scheduled publish happens twice. Turning this off is half of that migration;
    // a `payload jobs:run` container is the other half.
    expect(jobsAutoRunEnabled({ JOBS_AUTORUN: 'false', NODE_ENV: 'production' })).toBe(false)
    expect(jobsAutoRunEnabled({ JOBS_AUTORUN: 'true', NODE_ENV: 'development' })).toBe(true)
  })
})

describe('revalidation outside a request', () => {
  const payload = { logger: { warn: vi.fn() } } as never

  it('does not fail a write when there is no request context', () => {
    // Verified against the real thing: the jobs queue runs `payload.update` from a
    // timer, `revalidatePath` throws `Invariant: static generation store missing`,
    // and before this guard the scheduled publish retried to its limit and left the
    // document a draft — the feature silently not happening.
    expect(() =>
      tryRevalidate(payload, '/acme.example.com/fa/about', () => {
        throw new Error('Invariant: static generation store missing in revalidatePath')
      }),
    ).not.toThrow()

    // Logged, never swallowed silently: a genuine revalidation bug must stay visible.
    expect(
      (payload as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn,
    ).toHaveBeenCalledOnce()
  })

  it('still runs the revalidation when there is one', () => {
    const revalidate = vi.fn()

    tryRevalidate(payload, 'site:1:header', revalidate)

    expect(revalidate).toHaveBeenCalledOnce()
  })
})
