// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

import { GET } from '@/app/api/build-info/route'

const previousBuildSha = process.env.ESHOBE_BUILD_SHA

afterEach(() => {
  if (previousBuildSha === undefined) delete process.env.ESHOBE_BUILD_SHA
  else process.env.ESHOBE_BUILD_SHA = previousBuildSha
})

describe('CMS build fingerprint', () => {
  it('returns the deployed image revision without caching or other environment fields', async () => {
    process.env.ESHOBE_BUILD_SHA = 'a900eceef90391f760352ebdf792e6837da0e721'

    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('X-Eshobe-Build')).toBe(
      'a900eceef90391f760352ebdf792e6837da0e721',
    )
    expect(await response.json()).toEqual({
      build: 'a900eceef90391f760352ebdf792e6837da0e721',
    })
  })

  it('identifies local builds without leaking arbitrary environment information', async () => {
    delete process.env.ESHOBE_BUILD_SHA
    const response = GET()
    expect(await response.json()).toEqual({ build: 'unknown' })
  })
})
