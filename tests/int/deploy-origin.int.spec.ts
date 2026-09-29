import { afterEach, describe, expect, it } from 'vitest'

import { deployOrigin, previewHttpsUrl } from '@/lib/deploy/previewUrl'

describe('deploy origin scheme', () => {
  const original = process.env.DEPLOY_PUBLIC_SCHEME
  afterEach(() => {
    if (original === undefined) delete process.env.DEPLOY_PUBLIC_SCHEME
    else process.env.DEPLOY_PUBLIC_SCHEME = original
  })

  it('is https unless a developer machine opts out', () => {
    delete process.env.DEPLOY_PUBLIC_SCHEME
    expect(deployOrigin('a.example.com')).toBe('https://a.example.com')
    process.env.DEPLOY_PUBLIC_SCHEME = 'ftp'
    expect(deployOrigin('a.example.com')).toBe('https://a.example.com')
  })

  it('reads the setting per call, and every consumer follows it', () => {
    process.env.DEPLOY_PUBLIC_SCHEME = 'HTTP'
    expect(deployOrigin('a.127.0.0.1.sslip.io')).toBe('http://a.127.0.0.1.sslip.io')
    expect(previewHttpsUrl('a.127.0.0.1.sslip.io')).toBe('http://a.127.0.0.1.sslip.io')
    expect(previewHttpsUrl('')).toBeNull()
  })
})
