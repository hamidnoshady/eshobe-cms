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

  it('parses and validates home intro settings from a theme manifest', () => {
    const parsed = parseThemeManifest(
      {
        build: { buildPack: 'dockerfile', port: 3000 },
        contractVersion: 1,
        key: 'graphite',
        name: 'Graphite',
        settings: {
          introAnimation: { type: 'boolean', default: true },
          introDuration: { type: 'number', default: 7000, min: 0, max: 20_000 },
        },
        siteTypes: ['portfolio'],
      },
      1,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const withOverride = validateRuntimeSettings(parsed.manifest, {
      introAnimation: false,
      introDuration: 5000,
    })
    expect(withOverride.errors).toEqual([])
    expect(withOverride.values).toEqual({ introAnimation: false, introDuration: 5000 })
    const badDuration = validateRuntimeSettings(parsed.manifest, { introDuration: 25_000 })
    expect(badDuration.errors.length).toBeGreaterThan(0)
    const unknown = validateRuntimeSettings(parsed.manifest, { mysteryFlag: true })
    expect(unknown.errors.some((line) => line.includes('mysteryFlag'))).toBe(true)
  })
})
