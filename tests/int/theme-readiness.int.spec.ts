import { describe, expect, it } from 'vitest'

import {
  computeThemeReadiness,
  type ReadinessInput,
  type SlotState,
} from '@/deploy/readiness'

const present = (locales: string[], extra: Partial<NonNullable<SlotState>> = {}): SlotState => ({
  found: true,
  presentLocales: locales,
  unpublished: false,
  ...extra,
})

/** A fully prepared site; each test breaks exactly one thing. */
const ready = (overrides: Partial<ReadinessInput> = {}): ReadinessInput => ({
  assigned: true,
  domainVerified: true,
  packageName: 'Graphite',
  packagePublished: true,
  registry: { artifactReady: true, needed: true },
  siteLocales: ['fa', 'en'],
  siteTypeAllowed: true,
  slotStates: { aboutPage: present(['fa', 'en']), homePage: present(['fa', 'en']) },
  slots: [
    { key: 'homePage', labelFa: 'صفحه خانه', required: true, type: 'page' },
    { key: 'aboutPage', labelFa: 'صفحه درباره', required: false, type: 'page' },
  ],
  variables: [{ key: 'MAP_KEY', labelFa: 'کلید نقشه', required: true, set: true }],
  ...overrides,
})

const blockedIds = (input: ReadinessInput) =>
  computeThemeReadiness(input)
    .checks.filter((check) => check.status === 'blocked')
    .map((check) => check.id)

describe('theme readiness', () => {
  it('reports a fully prepared site as ready for both lanes with nothing open', () => {
    const result = computeThemeReadiness(ready())
    expect(result.readyForPreview).toBe(true)
    expect(result.readyForProduction).toBe(true)
    expect(result.nextStep).toBeNull()
    expect(result.checks.every((check) => check.status === 'ok')).toBe(true)
  })

  it('stops at "no theme assigned" instead of listing checks that mean nothing', () => {
    const result = computeThemeReadiness(ready({ assigned: false }))
    expect(result.checks.map((check) => check.id)).toEqual(['theme-assigned'])
    expect(result.readyForPreview).toBe(false)
    expect(result.nextStep?.id).toBe('theme-assigned')
    expect(result.nextStep?.owner).toBe('operator')
  })

  it('lets a preview proceed with an unbound required page but not production', () => {
    const result = computeThemeReadiness(ready({ slotStates: { aboutPage: present(['fa', 'en']), homePage: null } }))
    expect(result.readyForPreview).toBe(true)
    expect(result.readyForProduction).toBe(false)
    expect(result.nextStep).toMatchObject({ id: 'slot:homePage', owner: 'customer' })
    expect(result.nextStep?.message).toContain('صفحه خانه')
  })

  it('treats a deleted or foreign bound document like an unbound one, with its own wording', () => {
    const gone = computeThemeReadiness(
      ready({ slotStates: { aboutPage: null, homePage: { found: false, presentLocales: [], unpublished: false } } }),
    )
    expect(gone.nextStep?.id).toBe('slot:homePage')
    expect(gone.nextStep?.message).toContain('دیگر وجود ندارد')
  })

  it('does not nag about an unbound optional slot', () => {
    const result = computeThemeReadiness(ready({ slotStates: { homePage: present(['fa', 'en']) } }))
    expect(result.checks.find((check) => check.id === 'slot:aboutPage')).toBeUndefined()
    expect(result.readyForProduction).toBe(true)
  })

  it('warns — without gating — when a bound page is missing a served language', () => {
    const result = computeThemeReadiness(ready({ slotStates: { aboutPage: present(['fa']), homePage: present(['fa', 'en']) } }))
    const warning = result.checks.find((check) => check.id === 'slot-locale:aboutPage')
    expect(warning).toMatchObject({ blocks: null, status: 'warn' })
    // Named in Persian, and says where the fix is — the page, not the theme settings.
    expect(warning?.message).toContain('انگلیسی')
    expect(warning?.message).toContain('زبان ویرایشگر')
    expect(warning?.message).toContain('«زبان‌ها»')
    expect(result.readyForProduction).toBe(true)
    expect(result.nextStep?.id).toBe('slot-locale:aboutPage')
  })

  it('links a translation warning to the page editor, opened on the missing language', () => {
    const result = computeThemeReadiness(
      ready({
        slotStates: {
          aboutPage: present(['fa'], { editHref: '/admin/collections/pages/abc' }),
          homePage: present(['fa', 'en']),
        },
      }),
    )
    expect(result.checks.find((check) => check.id === 'slot-locale:aboutPage')?.href).toBe(
      '/admin/collections/pages/abc?locale=en',
    )
  })

  it('gates production on a required page that is still a draft, and only warns for an optional one', () => {
    expect(
      blockedIds(ready({ slotStates: { aboutPage: present(['fa', 'en']), homePage: present(['fa', 'en'], { unpublished: true }) } })),
    ).toEqual(['slot-draft:homePage'])
    const optional = computeThemeReadiness(
      ready({ slotStates: { aboutPage: present(['fa', 'en'], { unpublished: true }), homePage: present(['fa', 'en']) } }),
    )
    expect(optional.readyForProduction).toBe(true)
    expect(optional.checks.find((check) => check.id === 'slot-draft:aboutPage')?.status).toBe('warn')
  })

  it('blocks a preview on a missing required customer variable, naming it', () => {
    const result = computeThemeReadiness(
      ready({ variables: [{ key: 'MAP_KEY', labelFa: 'کلید نقشه', required: true, set: false }] }),
    )
    expect(result.readyForPreview).toBe(false)
    expect(result.nextStep).toMatchObject({ id: 'variable:MAP_KEY', owner: 'customer' })
    expect(result.nextStep?.message).toContain('کلید نقشه')
  })

  it('ignores an unset optional variable', () => {
    const result = computeThemeReadiness(
      ready({ variables: [{ key: 'GA', labelFa: null, required: false, set: false }] }),
    )
    expect(result.readyForPreview).toBe(true)
  })

  it('blocks on a registry package with no ready artifact, and skips the check for source builds', () => {
    expect(blockedIds(ready({ registry: { artifactReady: false, needed: true } }))).toEqual(['artifact-ready'])
    const source = computeThemeReadiness(ready({ registry: { artifactReady: false, needed: false } }))
    expect(source.checks.find((check) => check.id === 'artifact-ready')).toBeUndefined()
    expect(source.readyForPreview).toBe(true)
  })

  it('gates production, not preview, on an unverified domain', () => {
    const result = computeThemeReadiness(ready({ domainVerified: false }))
    expect(result.readyForPreview).toBe(true)
    expect(result.readyForProduction).toBe(false)
    expect(result.nextStep).toMatchObject({ id: 'domain-verified', owner: 'operator' })
  })

  it('refuses an unpublished package and an incompatible site type before anything else on the list', () => {
    expect(blockedIds(ready({ packagePublished: false, siteTypeAllowed: false }))).toEqual([
      'package-published',
      'site-type',
    ])
  })

  it('orders operator prerequisites ahead of customer content', () => {
    const result = computeThemeReadiness(
      ready({
        registry: { artifactReady: false, needed: true },
        slotStates: { aboutPage: null, homePage: null },
      }),
    )
    expect(result.checks.filter((check) => check.status === 'blocked').map((check) => check.id)).toEqual([
      'artifact-ready',
      'slot:homePage',
    ])
    expect(result.nextStep?.id).toBe('artifact-ready')
  })
})
