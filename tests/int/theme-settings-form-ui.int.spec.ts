import { describe, expect, it } from 'vitest'

import { fetchAllContentSlotOptions } from '@/deploy/admin/contentSlotOptions'
import { parseThemeManifest, validateRuntimeSettings } from '@/lib/deploy/manifest'
import {
  groupRuntimeSettings,
  resolveResponsiveFontSize,
  settingCategory,
} from '@/lib/deploy/theme-settings'

/**
 * Theme settings UI logic (without mounting Payload admin components — those need
 * the full Next bundle and are covered by `tests/e2e/theme-settings.e2e.spec.ts`).
 */
describe('theme settings form logic', () => {
  it('validates runtime settings the form submits', () => {
    const raw = {
      build: { pack: 'nixpacks', port: 3000 },
      contractVersion: 1,
      env: [],
      key: 'ui',
      name: 'UI',
      settings: {
        on: { default: false, type: 'boolean' },
        size: { default: 2, max: 5, min: 1, type: 'number' },
      },
      siteTypes: ['business'],
    }
    const parsed = parseThemeManifest(raw, 1)
    if (!parsed.ok) throw new Error(parsed.errors.join(' '))
    const result = validateRuntimeSettings(parsed.manifest, { on: true, size: 3 })
    expect(result.errors).toEqual([])
    expect(result.values).toMatchObject({ on: true, size: 3 })
  })

  it('loads more than 100 relationship options for content slots', async () => {
    const pages = await fetchAllContentSlotOptions(async ({ page }) => {
      if (page === 1) {
        return {
          docs: Array.from({ length: 100 }, (_, index) => ({ id: `${index}`, title: `T${index}` })),
          hasNextPage: true,
          nextPage: 2,
        }
      }
      return { docs: [{ id: '100', title: 'T100' }], hasNextPage: false }
    }, 'page')
    expect(pages).toHaveLength(101)
  })

  it('renders a 35-setting theme as categories, not one long stack', () => {
    const settings = Array.from({ length: 35 }, (_, index) => ({
      category: null,
      help: null,
      key: [
        'titleSize',
        'bodyFont',
        'primaryColor',
        'menuGap',
        'introAnimation',
        'contentWidth',
        'mysteryFlag',
      ][index % 7]! + index,
      labelEn: `Setting ${index}`,
      labelFa: `گزینهٔ ${index}`,
      section: index < 7 ? 'headings' : null,
      type: index === 0 ? 'responsiveFontSize' : 'number',
    }))
    const groups = groupRuntimeSettings(settings)
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(35)
    expect(groups.some((group) => group.category === 'typography')).toBe(true)
    expect(groups.some((group) => group.category === 'colors')).toBe(true)
    expect(groups.every((group) => group.sections.length >= 1)).toBe(true)

    const filtered = groupRuntimeSettings(settings, { query: 'Setting 12' })
    expect(filtered.flatMap((group) => group.sections).flatMap((section) => section.settings)).toHaveLength(1)
  })

  it('drives the device sample from the same resolver the server uses', () => {
    const setting = {
      category: 'typography' as const,
      default: { desktop: 42, mobile: 28, tablet: 34 },
      group: 'design' as const,
      key: 'titleSize',
      locales: ['fa' as const],
      max: 80,
      min: 14,
      section: 'headings',
      step: 1,
      type: 'responsiveFontSize' as const,
      unit: 'px' as const,
      advanced: false,
    }
    expect(settingCategory(setting)).toBe('typography')
    const resolution = resolveResponsiveFontSize(
      {
        default: { desktop: 42, mobile: 28, tablet: 34 },
        locales: ['fa'],
        max: 80,
        min: 14,
        step: 1,
        unit: 'px',
      },
      { desktop: 52, locales: { fa: { mobile: 20 } } },
      ['fa'],
    )
    expect(resolution.base.tablet.px).toBe(52)
    expect(resolution.locales.fa?.mobile).toEqual({ px: 20, source: 'custom' })
  })
})
