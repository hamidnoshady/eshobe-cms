import { describe, expect, it } from 'vitest'

import {
  parseThemeManifest,
  resolveRuntimeSettings,
  validateRuntimeSettings,
  type ThemeManifest,
} from '@/lib/deploy/manifest'
import {
  groupRuntimeSettings,
  resolveResponsiveFontSize,
  responsiveFontSizeOutput,
  settingCategory,
  splitStoredRuntimeSettings,
  TYPOGRAPHY_BREAKPOINTS,
} from '@/lib/deploy/theme-settings'

/**
 * The responsive-typography contract (#209 / ESH-179) and the legacy-preservation
 * primitive behind #212 / ESH-181.
 *
 * No database here on purpose: parse, validate and resolve are pure, so a failure
 * names the schema rule that broke rather than a fixture.
 */

const rawManifest = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  build: { pack: 'nixpacks', port: 3000 },
  contractVersion: 1,
  key: 'responsive-theme',
  name: 'Responsive theme',
  settings,
  siteTypes: ['business'],
  ...extra,
})

const manifest = (settings: Record<string, unknown> = {}): ThemeManifest => {
  const parsed = parseThemeManifest(
    rawManifest(settings, {
      settings: {
        title: {
          category: 'typography',
          default: { desktop: 42, mobile: 28, tablet: 34 },
          group: 'design',
          labelFa: 'اندازهٔ عنوان',
          locales: ['fa', 'en'],
          max: 80,
          min: 14,
          section: 'headings',
          step: 1,
          type: 'responsiveFontSize',
          unit: 'px',
        },
        bodyText: {
          default: { desktop: 18 },
          group: 'design',
          max: 30,
          min: 10,
          type: 'responsiveFontSize',
        },
        ...settings,
      },
    }),
    1,
  )
  if (!parsed.ok) throw new Error(parsed.errors.join(' '))
  return parsed.manifest
}

describe('manifest parsing — responsiveFontSize', () => {
  it('parses one setting per semantic role, keeping the primitive settings untouched', () => {
    const parsed = parseThemeManifest(
      rawManifest({
        showNumbers: { default: true, type: 'boolean' },
        title: {
          default: { desktop: 42, mobile: 28, tablet: 34 },
          locales: ['fa'],
          max: 80,
          min: 14,
          section: 'headings',
          type: 'responsiveFontSize',
        },
      }),
      1,
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.manifest.settings).toHaveLength(2)
    const [showNumbers, title] = parsed.manifest.settings
    expect(showNumbers).toMatchObject({ default: true, type: 'boolean', group: 'general' })
    expect(title).toMatchObject({
      category: 'typography',
      default: { desktop: 42, mobile: 28, tablet: 34 },
      group: 'design',
      locales: ['fa'],
      max: 80,
      min: 14,
      section: 'headings',
      step: 1,
      type: 'responsiveFontSize',
      unit: 'px',
    })
    // One role is one entry against the 50-setting cap, not three.
    expect(parsed.manifest.settings.filter((s) => s.type === 'responsiveFontSize')).toHaveLength(1)
  })

  it('rejects unknown nested keys, a non-px unit, scalar defaults and missing desktop', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown breakpoint', { desktop: 42, watch: 10 }],
      ['string value', { desktop: '42px' }],
      ['missing desktop', { mobile: 20 }],
    ]
    for (const [label, value] of cases) {
      const parsed = parseThemeManifest(
        rawManifest({ title: { default: value, max: 80, min: 14, type: 'responsiveFontSize' } }),
        1,
      )
      expect(parsed.ok, label).toBe(false)
    }

    for (const setting of [
      { default: { desktop: 42 }, type: 'responsiveFontSize', unit: 'rem' },
      { default: { desktop: 42 }, type: 'responsiveFontSize', options: [{ value: 'a' }] },
      { default: 42, type: 'responsiveFontSize' },
      { default: { desktop: 900 }, max: 80, min: 14, type: 'responsiveFontSize' },
      { default: { desktop: 14.4 }, max: 80, min: 14, step: 1, type: 'responsiveFontSize' },
      {
        default: { desktop: 42 },
        locales: ['de'],
        max: 80,
        min: 14,
        type: 'responsiveFontSize',
      },
    ]) {
      const parsed = parseThemeManifest(rawManifest({ title: setting }), 1)
      expect(parsed.ok, JSON.stringify(setting)).toBe(false)
    }
  })

  it('rejects an invalid category or section instead of silently ungrouping the field', () => {
    for (const setting of [
      { default: { desktop: 16 }, max: 40, min: 10, type: 'responsiveFontSize', category: 'evil' },
      { default: { desktop: 16 }, max: 40, min: 10, type: 'responsiveFontSize', section: 'a b' },
    ]) {
      expect(parseThemeManifest(rawManifest({ title: setting }), 1).ok).toBe(false)
    }
  })
})

describe('validateRuntimeSettings — responsive values', () => {
  it('accepts explicit device values and refuses a scalar or a CSS string', () => {
    const theme = manifest()
    const ok = validateRuntimeSettings(theme, { title: { desktop: 48, tablet: 36 } })
    expect(ok.errors).toEqual([])
    expect(ok.values.title).toEqual({ desktop: 48, tablet: 36 })

    for (const value of [100, '42px', '42', [42], { desktop: 48, watch: 30 }]) {
      const bad = validateRuntimeSettings(theme, { title: value })
      expect(bad.errors.length, JSON.stringify(value)).toBeGreaterThan(0)
    }
  })

  it('enforces the manifest bounds and step on stored values', () => {
    const theme = manifest()
    expect(validateRuntimeSettings(theme, { title: { desktop: 10 } }).errors.length).toBeGreaterThan(0)
    expect(validateRuntimeSettings(theme, { title: { desktop: 400 } }).errors.length).toBeGreaterThan(0)
    expect(
      validateRuntimeSettings(theme, { title: { desktop: 14.5 } }).errors.length,
    ).toBeGreaterThan(0)
    expect(validateRuntimeSettings(theme, { title: { desktop: 15 } }).errors).toEqual([])
  })

  it('refuses a locale the setting did not declare', () => {
    const theme = manifest()
    const bad = validateRuntimeSettings(theme, {
      title: { locales: { en: { desktop: 21 } } },
    })
    // `title` declares fa+en, `bodyText` none. The same value under bodyText is the
    // one that must fail.
    expect(bad.errors).toEqual([])
    const refused = validateRuntimeSettings(theme, {
      bodyText: { locales: { en: { desktop: 21 } } },
    })
    expect(refused.errors.length).toBeGreaterThan(0)
  })

  it('applies no defaults when asked, so the form can tell inherited from custom', () => {
    const theme = manifest()
    const explicit = validateRuntimeSettings(theme, {}, { applyDefaults: false })
    expect(explicit.values).toEqual({})
    const withDefaults = validateRuntimeSettings(theme, {})
    expect(withDefaults.values.title).toEqual({ desktop: 42, mobile: 28, tablet: 34 })
    expect(withDefaults.values.bodyText).toEqual({ desktop: 18 })
  })
})

describe('resolveRuntimeSettings — precedence and output', () => {
  it('inherits desktop → tablet → mobile and lets an explicit device win', () => {
    const theme = manifest()
    const resolved = resolveRuntimeSettings(theme, { title: { desktop: 50 } })
    expect(resolved.title).toMatchObject({ desktop: 50, mobile: 50, tablet: 50, unit: 'px' })

    const tablet = resolveRuntimeSettings(theme, { title: { desktop: 50, tablet: 40 } })
    expect(tablet.title).toMatchObject({ desktop: 50, mobile: 40, tablet: 40 })
  })

  it('falls back to the theme default per breakpoint when nothing is saved', () => {
    const theme = manifest()
    const resolved = resolveRuntimeSettings(theme, {})
    expect(resolved.title).toMatchObject({ desktop: 42, mobile: 28, tablet: 34 })
    // bodyText declares only desktop; the smaller devices inherit it.
    expect(resolved.bodyText).toMatchObject({ desktop: 18, mobile: 18, tablet: 18 })
  })

  it('layers a locale override over base values and keeps the base fallback', () => {
    const theme = manifest()
    const setting = theme.settings.find((entry) => entry.key === 'title')!
    const spec = {
      default: { desktop: 42, mobile: 28, tablet: 34 },
      locales: ['fa' as const, 'en' as const],
      max: setting.max!,
      min: setting.min!,
      step: 1,
      unit: 'px' as const,
    }
    const resolution = resolveResponsiveFontSize(spec, {
      desktop: 50,
      locales: { fa: { tablet: 30 } },
    })
    expect(resolution.base.desktop).toEqual({ px: 50, source: 'custom' })
    expect(resolution.base.tablet).toEqual({ px: 50, source: 'inherited' })
    expect(resolution.locales.fa?.desktop).toEqual({ px: 50, source: 'base' })
    expect(resolution.locales.fa?.tablet).toEqual({ px: 30, source: 'custom' })
    expect(resolution.locales.fa?.mobile).toEqual({ px: 30, source: 'inherited' })

    const output = responsiveFontSizeOutput(spec, { desktop: 50, locales: { fa: { tablet: 30 } } })
    expect(output).toEqual({
      desktop: 50,
      locales: { fa: { desktop: 50, mobile: 30, tablet: 30 } },
      mobile: 50,
      tablet: 50,
      unit: 'px',
    })
  })

  it('round-trips through JSON without losing the shape', () => {
    const theme = manifest()
    const wire = JSON.parse(
      JSON.stringify(resolveRuntimeSettings(theme, { title: { desktop: 48, mobile: 32 } })),
    )
    expect(wire.title).toEqual({ desktop: 48, mobile: 32, tablet: 48, unit: 'px' })
    expect(TYPOGRAPHY_BREAKPOINTS).toEqual(['desktop', 'tablet', 'mobile'])
  })
})

describe('legacy preservation primitive', () => {
  it('separates a scalar percent under a responsive key from usable values', () => {
    const theme = manifest()
    const split = splitStoredRuntimeSettings(theme.settings, {
      bodyText: { desktop: 20 },
      oldHeading: 100,
      title: 100,
    })
    expect(split.runtime).toEqual({ bodyText: { desktop: 20 } })
    expect(split.legacy).toEqual({ oldHeading: 100, title: 100 })
    expect(split.legacyDeclaredKeys).toEqual(['title'])
  })

  it('never treats an undeclared key as a usable value, whatever its shape', () => {
    const split = splitStoredRuntimeSettings([{ key: 'title', type: 'responsiveFontSize' }], {
      title: { desktop: 20 },
      stale: { desktop: 20 },
    })
    expect(split.runtime).toEqual({ title: { desktop: 20 } })
    expect(split.legacy).toEqual({ stale: { desktop: 20 } })
  })
})

describe('category inference and grouping', () => {
  it('groups a 35-setting theme into the six categories and searches by label', () => {
    const settings = Array.from({ length: 35 }, (_, index) => ({
      category: null,
      help: null,
      key: `option${index}`,
      labelEn: index === 4 ? 'Hero heading size' : `Option ${index}`,
      labelFa: null,
      section: index < 5 ? 'headings' : null,
      type: index === 4 ? 'responsiveFontSize' : 'number',
    }))
    const groups = groupRuntimeSettings(settings, {})
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(35)
    const typography = groups.find((group) => group.category === 'typography')
    expect(typography?.sections[0]).toMatchObject({ count: 1, key: 'headings' })

    const search = groupRuntimeSettings(settings, { query: 'hero heading' })
    expect(search).toHaveLength(1)
    expect(search[0]!.sections[0]!.settings[0]!.key).toBe('option4')
  })

  it('prefers an explicit category and infers a sensible one otherwise', () => {
    expect(settingCategory({ category: 'motion', key: 'title', type: 'number' })).toBe('motion')
    expect(settingCategory({ category: null, key: 'titleSize', type: 'number' })).toBe('typography')
    expect(settingCategory({ category: null, key: 'primaryColor', type: 'text' })).toBe('colors')
    expect(settingCategory({ category: null, key: 'menuGap', type: 'number' })).toBe('navigation')
    expect(settingCategory({ category: null, key: 'unknownThing', type: 'number' })).toBe(
      'advanced',
    )
  })
})
