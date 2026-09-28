import { describe, expect, it } from 'vitest'

import { parseThemeManifest } from '@/lib/deploy/manifest'

const base = { build: { port: 3000 }, contractVersion: 1, key: 'graphite', name: 'Graphite' }

describe('theme manifest design defaults', () => {
  it('accepts an absent or valid optional design section', () => {
    expect(parseThemeManifest(base, 1).ok).toBe(true)
    const parsed = parseThemeManifest({ ...base, design: { primary: '#0f766e', radius: 'md', lineHeight: 1.8 } }, 1)
    expect(parsed.ok && parsed.manifest.design.primary).toBe('#0f766e')
  })

  it('rejects unsafe and unsupported design values', () => {
    expect(parseThemeManifest({ ...base, design: { primary: 'red' } }, 1).ok).toBe(false)
    expect(parseThemeManifest({ ...base, design: { radius: 'round' } }, 1).ok).toBe(false)
    expect(parseThemeManifest({ ...base, design: { lineHeight: 9 } }, 1).ok).toBe(false)
    expect(parseThemeManifest({ ...base, design: { command: 'rm -rf /' } }, 1).ok).toBe(false)
  })
})
