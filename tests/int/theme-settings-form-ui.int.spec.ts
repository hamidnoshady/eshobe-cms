import { describe, expect, it } from 'vitest'

import {
  contentSlotSearchWhere,
  fetchAllContentSlotOptions,
  mapContentDocsToOptions,
} from '@/deploy/admin/contentSlotOptions'
import { parseThemeManifest, validateRuntimeSettings } from '@/lib/deploy/manifest'

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

  it('builds search filters used by the slot picker', () => {
    expect(contentSlotSearchWhere('post', 'news')?.or).toBeTruthy()
  })
})
