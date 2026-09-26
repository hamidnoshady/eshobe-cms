// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { contractVersion, themeCss } from '@eshobe/site-runtime'
import { blockSlugsForSiteType } from '@eshobe/site-runtime/blocks'
import { formatPrice } from '@eshobe/site-runtime/format'
import { localeHref } from '@eshobe/site-runtime/locale'

/** The same public entry points an external theme installs from the registry. */
describe('@eshobe/site-runtime package exports', () => {
  it('loads built ESM entry points without Payload or application imports', () => {
    expect(contractVersion).toBe(1)
    expect(themeCss({ primary: '#0f766e', radius: 'md' })).toContain('--primary:#0f766e')
    expect(blockSlugsForSiteType('portfolio')).toContain('contact')
    expect(localeHref('/projects', 'fa', 'fa')).toBe('/projects')
    expect(formatPrice(125_000, 'IRT', 'fa')).toContain('۱۲۵')
  })
})
