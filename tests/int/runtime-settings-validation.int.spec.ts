import { describe, expect, it } from 'vitest'

import { parseThemeManifest, validateRuntimeSettings } from '@/lib/deploy/manifest'

const manifest = () => {
  const parsed = parseThemeManifest(
    {
      build: { pack: 'nixpacks', port: 3000 },
      contractVersion: 1,
      env: [],
      key: 'runtime-validation',
      name: 'Runtime validation',
      settings: {
        enabled: { default: true, type: 'boolean' },
        label: { type: 'text' },
        size: { default: 5, max: 10, min: 1, type: 'number' },
        variant: {
          options: [{ value: 'a' }, { value: 'b' }],
          type: 'select',
        },
      },
      siteTypes: ['business'],
    },
    1,
  )
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}

describe('validateRuntimeSettings', () => {
  it('applies boolean defaults and accepts explicit values', () => {
    const empty = validateRuntimeSettings(manifest(), {})
    expect(empty.values.enabled).toBe(true)
    const off = validateRuntimeSettings(manifest(), { enabled: false })
    expect(off.errors).toEqual([])
    expect(off.values.enabled).toBe(false)
  })

  it('rejects unknown select options and out-of-range numbers', () => {
    const badSelect = validateRuntimeSettings(manifest(), { variant: 'z' })
    expect(badSelect.errors.length).toBeGreaterThan(0)
    const badNumber = validateRuntimeSettings(manifest(), { size: 99 })
    expect(badNumber.errors.length).toBeGreaterThan(0)
  })

  it('rejects text longer than the platform cap', () => {
    const bad = validateRuntimeSettings(manifest(), { label: 'x'.repeat(501) })
    expect(bad.errors.length).toBeGreaterThan(0)
  })
})
