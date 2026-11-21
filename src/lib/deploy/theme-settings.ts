/**
 * The parts of the theme-settings contract that are shared by the manifest parser,
 * the customer endpoint, `GET /api/site` and the admin form.
 *
 * Framework-free on purpose, like `manifest.ts`: no `payload` import, so the unit
 * spec can exercise resolution and validation without a database and the renderer can
 * use the same function the CMS uses. The admin must never re-implement px maths —
 * "the number in the box" and "the number the theme receives" have to be one answer.
 *
 * ## Why a second setting type instead of three keys
 *
 * A typography role (page title, body copy) has one value per viewport. Modelling it
 * as three settings (`titleSizeDesktop`, …) would multiply a manifest that already has
 * a hard 50-entry cap and let a customer save tablet without desktop. One setting
 * carries every breakpoint, so the whole role is validated and reset as a unit.
 *
 * ## Legacy values are never converted here
 *
 * Existing manifests declare `number` sizes on a percent scale where `100` is the
 * original design. A percentage of a fluid `clamp()` curve has no single px equivalent,
 * so this module refuses to guess: a stored scalar under a key that is now
 * `responsiveFontSize` is *legacy data* (`splitStoredRuntimeSettings`) and is never
 * read as a px value.
 */

/** The one new manifest type. Kept as one constant so the parser and the UI cannot drift. */
export const RESPONSIVE_TYPOGRAPHY_TYPE = 'responsiveFontSize'
export type ResponsiveTypographyType = typeof RESPONSIVE_TYPOGRAPHY_TYPE

export const TYPOGRAPHY_BREAKPOINTS = ['desktop', 'tablet', 'mobile'] as const
export type TypographyBreakpoint = (typeof TYPOGRAPHY_BREAKPOINTS)[number]

/**
 * The platform's supported languages, not "whatever a manifest lists". A locale key
 * outside this set can never reach a rendered page, so accepting it would store a
 * preference nothing reads.
 */
export const TYPOGRAPHY_LOCALES = ['fa', 'en'] as const
export type TypographyLocale = (typeof TYPOGRAPHY_LOCALES)[number]

/**
 * Representative viewport widths for the admin's device preview. These are the widths
 * the documentation and E2E tests speak in, and they match the CSS breakpoint ranges
 * below; they are *not* user-agent detection.
 */
export const TYPOGRAPHY_DEVICE_WIDTHS: Record<TypographyBreakpoint, number> = {
  desktop: 1440,
  mobile: 375,
  tablet: 768,
}

/** Documented ranges the responsive CSS is expected to switch at. */
export const TYPOGRAPHY_BREAKPOINT_RANGES: Record<
  TypographyBreakpoint,
  { max?: number; min?: number }
> = {
  desktop: { min: 1024 },
  mobile: { max: 767 },
  tablet: { max: 1023, min: 768 },
}

/**
 * Absolute limits for a px override. A theme may narrow these; it may not widen them.
 * The upper bound is a guard against a typo becoming a 4 000px heading, not a design
 * opinion — themes declare their own `min`/`max` inside this window.
 */
export const RESPONSIVE_FONT_SIZE_LIMITS = { max: 400, min: 1 } as const
export const RESPONSIVE_STEP_LIMITS = { max: 50, min: 0.5 } as const

export type ResponsiveDeviceValues = Partial<Record<TypographyBreakpoint, number>>
export type ResponsiveLocaleOverrides = Partial<Record<TypographyLocale, ResponsiveDeviceValues>>
export type ResponsiveFontSizeValue = ResponsiveDeviceValues & {
  locales?: ResponsiveLocaleOverrides
}

/** The validated schema side of a `responsiveFontSize` setting. */
export type ResponsiveFontSizeSpec = {
  default: Required<Pick<ResponsiveDeviceValues, 'desktop'>> & ResponsiveDeviceValues
  locales: TypographyLocale[]
  max: number
  min: number
  step: number
  unit: 'px'
}

/** Where the admin renders a setting. Ordered as the UI shows them. */
export const SETTING_CATEGORIES = [
  'typography',
  'colors',
  'layout',
  'navigation',
  'motion',
  'advanced',
] as const
export type SettingCategory = (typeof SETTING_CATEGORIES)[number]

export const SETTING_CATEGORY_LABELS: Record<SettingCategory, { en: string; fa: string }> = {
  advanced: { en: 'Advanced', fa: 'پیشرفته' },
  colors: { en: 'Colours', fa: 'رنگ‌ها' },
  layout: { en: 'Layout & spacing', fa: 'چیدمان و فاصله‌ها' },
  motion: { en: 'Motion', fa: 'حرکت و انیمیشن' },
  navigation: { en: 'Navigation', fa: 'ناوبری' },
  typography: { en: 'Typography', fa: 'تایپوگرافی' },
}

export const SETTING_SECTION_LABELS: Record<string, { en: string; fa: string }> = {
  body: { en: 'Body text', fa: 'متن اصلی' },
  buttons: { en: 'Buttons', fa: 'دکمه‌ها' },
  cards: { en: 'Cards', fa: 'کارت‌ها' },
  forms: { en: 'Forms', fa: 'فرم‌ها' },
  general: { en: 'General', fa: 'عمومی' },
  headings: { en: 'Headings', fa: 'عنوان‌ها' },
  interface: { en: 'Interface', fa: 'عناصر رابط' },
  labels: { en: 'Labels & meta', fa: 'برچسب‌ها' },
  menu: { en: 'Menus', fa: 'منوها' },
  spacing: { en: 'Spacing', fa: 'فاصله‌ها' },
}

const SETTING_SECTION_PATTERN = /^[a-z][a-zA-Z0-9-]{0,31}$/

export const isSettingCategory = (value: unknown): value is SettingCategory =>
  typeof value === 'string' && (SETTING_CATEGORIES as readonly string[]).includes(value)

export const isTypographyLocale = (value: unknown): value is TypographyLocale =>
  typeof value === 'string' && (TYPOGRAPHY_LOCALES as readonly string[]).includes(value)

export const parseSettingSection = (value: unknown): null | string => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return SETTING_SECTION_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * The category a setting is shown under.
 *
 * An explicit allowlisted `category` wins. Older manifests have none, and a 35-setting
 * theme must still be navigable the day this ships, so the fallback reads the trusted
 * key itself: manifest keys are `/^[a-z][A-Za-z0-9]{0,63}$/`, never free text, and a
 * wrong guess only changes which group a control appears in — never how it is
 * validated or stored.
 */
export const settingCategory = (setting: {
  category?: null | SettingCategory
  key: string
  type: string
}): SettingCategory => {
  if (isSettingCategory(setting.category)) return setting.category
  if (setting.type === RESPONSIVE_TYPOGRAPHY_TYPE) return 'typography'
  const key = setting.key.toLowerCase()
  if (
    /font|type|heading|title|line.?height|leading|weight|text|letter.?spacing|body|paragraph|copy|caption|meta/.test(
      key,
    )
  )
    return 'typography'
  if (/colou?r|palette|background|foreground|accent|primary|border/.test(key)) return 'colors'
  if (/nav|menu|header|footer|breadcrumb|logo.?link/.test(key)) return 'navigation'
  if (/motion|animation|animate|transition|duration|delay|speed|ease|intro/.test(key))
    return 'motion'
  if (
    /space|spacing|gap|margin|padding|radius|width|height|column|grid|container|layout|align|density|size/.test(
      key,
    )
  )
    return 'layout'
  return 'advanced'
}

/** A section label for an arbitrary (already validated) section key. */
export const settingSectionLabel = (
  section: string,
  english: boolean,
): string => {
  const known = SETTING_SECTION_LABELS[section]
  if (known) return english ? known.en : known.fa
  const humanized = section.replace(/-/g, ' ')
  return humanized.charAt(0).toUpperCase() + humanized.slice(1)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const breakpointSet = new Set<string>(TYPOGRAPHY_BREAKPOINTS)

/** Round only for display/text; the stored value keeps the customer's decimals. */
const px = (value: number): number => Math.round(value * 100) / 100

/** `step` is a UI affordance and a storage contract: 42 is valid for step 1, 42.5 is not. */
const onStepGrid = (value: number, spec: { min: number; step: number }): boolean => {
  const steps = (value - spec.min) / spec.step
  return Math.abs(steps - Math.round(steps)) < 1e-9
}

/**
 * Parse the manifest's `responsiveFontSize` row.
 *
 * Every nested key is an allowlist. This object arrives from a third-party repository,
 * so an unknown key is a rejection rather than a field the CMS silently carries around;
 * `unit` may only be `px`, and no string value is accepted where a number is expected,
 * which is what keeps `"42px; background:url(…)"` out of a CSS custom property.
 */
export const parseResponsiveFontSizeSpec = (
  row: Record<string, unknown>,
  key: string,
  errors: string[],
): null | ResponsiveFontSizeSpec => {
  const before = errors.length
  const prefix = `settings.${key}`

  if (row.options !== undefined) {
    errors.push(`«${prefix}.options» برای ${RESPONSIVE_TYPOGRAPHY_TYPE} معنا ندارد.`)
  }
  if (row.unit !== undefined && row.unit !== 'px') {
    errors.push(`«${prefix}.unit» فقط می‌تواند «px» باشد.`)
  }

  const numberOr = (value: unknown, fallback: number, label: string): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`«${prefix}.${label}» باید یک عدد باشد.`)
      return fallback
    }
    return value
  }

  const min = numberOr(row.min, RESPONSIVE_FONT_SIZE_LIMITS.min, 'min')
  const max = numberOr(row.max, 96, 'max')
  const step = numberOr(row.step, 1, 'step')

  if (min < RESPONSIVE_FONT_SIZE_LIMITS.min || min > RESPONSIVE_FONT_SIZE_LIMITS.max) {
    errors.push(
      `«${prefix}.min» باید بین ${RESPONSIVE_FONT_SIZE_LIMITS.min} و ${RESPONSIVE_FONT_SIZE_LIMITS.max} باشد.`,
    )
  }
  if (max < RESPONSIVE_FONT_SIZE_LIMITS.min || max > RESPONSIVE_FONT_SIZE_LIMITS.max) {
    errors.push(
      `«${prefix}.max» باید بین ${RESPONSIVE_FONT_SIZE_LIMITS.min} و ${RESPONSIVE_FONT_SIZE_LIMITS.max} باشد.`,
    )
  }
  if (max <= min) errors.push(`«${prefix}.max» باید بزرگ‌تر از min باشد.`)
  if (step < RESPONSIVE_STEP_LIMITS.min || step > RESPONSIVE_STEP_LIMITS.max) {
    errors.push(
      `«${prefix}.step» باید بین ${RESPONSIVE_STEP_LIMITS.min} و ${RESPONSIVE_STEP_LIMITS.max} باشد.`,
    )
  }

  const parseDevices = (raw: unknown, label: string): ResponsiveDeviceValues => {
    if (!isPlainObject(raw)) {
      errors.push(`«${prefix}.${label}» باید یک شیء با کلیدهای desktop/tablet/mobile باشد.`)
      return {}
    }
    const out: ResponsiveDeviceValues = {}
    for (const [device, value] of Object.entries(raw)) {
      if (!breakpointSet.has(device)) {
        errors.push(`کلید «${prefix}.${label}.${device}» پشتیبانی نمی‌شود.`)
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`«${prefix}.${label}.${device}» باید یک عدد باشد.`)
        continue
      }
      const rounded = px(value)
      if (rounded < min || rounded > max) {
        errors.push(
          `«${prefix}.${label}.${device}» باید بین ${min} و ${max} باشد.`,
        )
        continue
      }
      if (!onStepGrid(rounded, { min, step })) {
        errors.push(`«${prefix}.${label}.${device}» باید مضربی از ${step} باشد.`)
        continue
      }
      out[device as TypographyBreakpoint] = rounded
    }
    return out
  }

  const defaults = parseDevices(row.default, 'default')
  if (row.default !== undefined && defaults.desktop === undefined) {
    errors.push(`«${prefix}.default.desktop» الزامی است؛ سایر دستگاه‌ها از آن ارث می‌برند.`)
  }

  let locales: TypographyLocale[] = []
  if (row.locales !== undefined) {
    if (!Array.isArray(row.locales) || row.locales.length > TYPOGRAPHY_LOCALES.length) {
      errors.push(`«${prefix}.locales» باید آرایه‌ای از ${TYPOGRAPHY_LOCALES.join('، ')} باشد.`)
    } else {
      locales = row.locales.flatMap((value) => {
        if (!isTypographyLocale(value)) {
          errors.push(`کلید زبان «${String(value)}» در ${prefix}.locales پشتیبانی نمی‌شود.`)
          return []
        }
        return [value]
      })
      if (new Set(locales).size !== locales.length) {
        errors.push(`«${prefix}.locales» تکراری دارد.`)
        locales = [...new Set(locales)]
      }
    }
  }

  if (errors.length > before) return null
  return { default: defaults as ResponsiveFontSizeSpec['default'], locales, max, min, step, unit: 'px' }
}

/**
 * Validate a stored value against the setting's own bounds.
 *
 * Returns `{}` for "use the theme default" (a deliberate, resettable state) and
 * `null` when the value is not this setting's shape at all. Scalars (`100`, `"42px"`,
 * arrays) are refused — that is the boundary that stops a legacy percent becoming px.
 */
export const normalizeResponsiveFontSizeValue = (
  spec: ResponsiveFontSizeSpec,
  raw: unknown,
  key: string,
  errors: string[],
): null | ResponsiveFontSizeValue => {
  if (raw === undefined || raw === null) return null
  if (!isPlainObject(raw)) {
    errors.push(`مقدار «${key}» باید شیء px برای هر دستگاه باشد، نه عدد یا متن.`)
    return null
  }

  const allowed = new Set<string>([...TYPOGRAPHY_BREAKPOINTS, 'locales'])
  let failed = false

  const parseDevices = (value: unknown, label: string): ResponsiveDeviceValues => {
    if (!isPlainObject(value)) {
      errors.push(`مقدار «${label}» باید یک شیء باشد.`)
      failed = true
      return {}
    }
    const out: ResponsiveDeviceValues = {}
    for (const [device, candidate] of Object.entries(value)) {
      const where = label ? `${key}.${label}.${device}` : `${key}.${device}`
      if (!breakpointSet.has(device)) {
        errors.push(`کلید «${where}» پشتیبانی نمی‌شود.`)
        failed = true
        continue
      }
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
        errors.push(`مقدار «${where}» باید یک عدد باشد.`)
        failed = true
        continue
      }
      const rounded = px(candidate)
      if (rounded < spec.min || rounded > spec.max) {
        errors.push(`مقدار «${where}» باید بین ${spec.min} و ${spec.max} باشد.`)
        failed = true
        continue
      }
      if (!onStepGrid(rounded, spec)) {
        errors.push(`مقدار «${where}» باید مضربی از ${spec.step} باشد.`)
        failed = true
        continue
      }
      out[device as TypographyBreakpoint] = rounded
    }
    return out
  }

  const value: ResponsiveFontSizeValue = {}
  for (const [key_, candidate] of Object.entries(raw)) {
    if (!allowed.has(key_)) {
      errors.push(`کلید «${key}.${key_}» پشتیبانی نمی‌شود.`)
      failed = true
      continue
    }
    if (key_ === 'locales') {
      if (!isPlainObject(candidate)) {
        errors.push(`«${key}.locales» باید یک شیء باشد.`)
        failed = true
        continue
      }
      const overrides: ResponsiveLocaleOverrides = {}
      for (const [locale, devices] of Object.entries(candidate)) {
        if (!isTypographyLocale(locale) || !spec.locales.includes(locale)) {
          errors.push(`زبان «${key}.locales.${locale}» در این گزینه تعریف نشده است.`)
          failed = true
          continue
        }
        overrides[locale] = parseDevices(devices, `locales.${locale}`)
      }
      if (Object.keys(overrides).length) value.locales = overrides
      continue
    }
    value[key_ as TypographyBreakpoint] = parseDevices(
      { [key_]: candidate },
      '',
    )[key_ as TypographyBreakpoint]
  }

  return failed ? null : value
}

export type ResponsiveResolutionSource = 'base' | 'custom' | 'inherited' | 'theme'
export type ResponsiveBreakpointResolution = {
  px: number
  source: ResponsiveResolutionSource
}
export type ResponsiveLayerResolution = Record<TypographyBreakpoint, ResponsiveBreakpointResolution>

export type ResolvedResponsiveFontSize = {
  base: ResponsiveLayerResolution
  locales: Partial<Record<TypographyLocale, ResponsiveLayerResolution>>
  unit: 'px'
}

const resolveBase = (
  spec: ResponsiveFontSizeSpec,
  value: null | ResponsiveFontSizeValue,
): ResponsiveLayerResolution => {
  const out = {} as ResponsiveLayerResolution
  let carried: null | number = null
  let carriedFromTheme = false
  for (const device of TYPOGRAPHY_BREAKPOINTS) {
    const explicit = value?.[device]
    if (explicit !== undefined) {
      out[device] = { px: explicit, source: 'custom' }
      carried = explicit
      carriedFromTheme = false
      continue
    }
    if (carried !== null && !carriedFromTheme) {
      out[device] = { px: carried, source: 'inherited' }
      continue
    }
    const fallback = spec.default[device] ?? spec.default.desktop
    out[device] = { px: fallback, source: 'theme' }
    carried = fallback
    carriedFromTheme = true
  }
  return out
}

const resolveLocale = (
  localeValue: null | undefined | ResponsiveDeviceValues,
  base: ResponsiveLayerResolution,
): ResponsiveLayerResolution => {
  const out = {} as ResponsiveLayerResolution
  let carried: null | number = null
  for (const device of TYPOGRAPHY_BREAKPOINTS) {
    const explicit = localeValue?.[device]
    if (explicit !== undefined) {
      out[device] = { px: explicit, source: 'custom' }
      carried = explicit
      continue
    }
    if (carried !== null) {
      out[device] = { px: carried, source: 'inherited' }
      continue
    }
    out[device] = { px: base[device].px, source: 'base' }
  }
  return out
}

/**
 * Resolve one role for every breakpoint.
 *
 * Precedence, in the order the documentation states it: explicit locale + device →
 * inherited locale + device → explicit base device → inherited base device → theme
 * default. The returned `source` is what lets the form say "inherited from desktop"
 * instead of showing a number the customer never typed.
 */
export const resolveResponsiveFontSize = (
  spec: ResponsiveFontSizeSpec,
  value: null | undefined | ResponsiveFontSizeValue,
  locales: readonly TypographyLocale[] = spec.locales,
): ResolvedResponsiveFontSize => {
  const base = resolveBase(spec, value ?? null)
  const resolved: ResolvedResponsiveFontSize = { base, locales: {}, unit: 'px' }
  for (const locale of locales) {
    if (!spec.locales.includes(locale)) continue
    resolved.locales[locale] = resolveLocale(value?.locales?.[locale], base)
  }
  return resolved
}

/** What `GET /api/site` emits: resolved px per breakpoint, inheritance already applied. */
export type ResponsiveFontSizeOutput = {
  desktop: number
  locales?: Partial<Record<TypographyLocale, Required<ResponsiveDeviceValues>>>
  mobile: number
  tablet: number
  unit: 'px'
}

export const responsiveFontSizeOutput = (
  spec: ResponsiveFontSizeSpec,
  value: null | undefined | ResponsiveFontSizeValue,
): ResponsiveFontSizeOutput => {
  const resolved = resolveResponsiveFontSize(spec, value)
  const output: ResponsiveFontSizeOutput = {
    desktop: resolved.base.desktop.px,
    mobile: resolved.base.mobile.px,
    tablet: resolved.base.tablet.px,
    unit: 'px',
  }
  /**
   * Only languages the customer actually overrode. A declared-but-untouched locale is
   * base behaviour by definition; repeating the base numbers under `fa` and `en` would
   * make a theme author treat "present" as "different" and ship redundant CSS.
   */
  const locales = Object.keys(value?.locales ?? {}).flatMap((locale) =>
    resolved.locales[locale as keyof typeof resolved.locales]
      ? [
          [
            locale,
            {
              desktop: resolved.locales[locale as keyof typeof resolved.locales]!.desktop.px,
              mobile: resolved.locales[locale as keyof typeof resolved.locales]!.mobile.px,
              tablet: resolved.locales[locale as keyof typeof resolved.locales]!.tablet.px,
            },
          ] as const,
        ]
      : [],
  )
  if (locales.length) output.locales = Object.fromEntries(locales)
  return output
}

export type ResponsiveFontSizeCssOptions = {
  /** CSS property to set. Defaults to `font-size`. */
  property?: string
  /** A theme-owned selector, for example `.page-title`. */
  selector: string
}

const cssRule = (selector: string, property: string, px: number): string =>
  `${selector} { ${property}: ${px}px; }`

/**
 * A reference emitter for themes: resolved px as real CSS, with the documented
 * breakpoints and locale scoping.
 *
 * This is deliberately the *only* place the CMS turns a resolved value into CSS, so a
 * theme has a correct implementation to copy and the contract test can measure computed
 * styles rather than assert an admin number. It is not a styling system: the theme owns
 * the selector and the semantic token, the CMS owns the numbers and their bounds.
 *
 * `selector` comes from theme source (trusted, like any stylesheet); every interpolated
 * value is a validated finite number or an allowlisted locale, never customer text.
 */
export const responsiveFontSizeCss = (
  spec: ResponsiveFontSizeSpec,
  value: null | undefined | ResponsiveFontSizeValue,
  options: ResponsiveFontSizeCssOptions,
): string => {
  const selector = options.selector.trim()
  if (!selector) throw new Error('responsiveFontSizeCss: selector is required')
  const property = options.property ?? 'font-size'
  const resolved = resolveResponsiveFontSize(spec, value)
  const rules = [
    cssRule(selector, property, resolved.base.desktop.px),
    `@media (max-width: 1023px) {\n  ${cssRule(selector, property, resolved.base.tablet.px)}\n}`,
    `@media (max-width: 767px) {\n  ${cssRule(selector, property, resolved.base.mobile.px)}\n}`,
  ]

  for (const locale of spec.locales) {
    const layer = resolved.locales[locale]
    if (!layer) continue
    // A locale with no effective difference would only add bytes and specificity.
    if (TYPOGRAPHY_BREAKPOINTS.every((device) => layer[device].px === resolved.base[device].px))
      continue
    const scoped = `:root[lang="${locale}"] ${selector}`
    rules.push(
      cssRule(scoped, property, layer.desktop.px),
      `@media (max-width: 1023px) {\n  ${cssRule(scoped, property, layer.tablet.px)}\n}`,
      `@media (max-width: 767px) {\n  ${cssRule(scoped, property, layer.mobile.px)}\n}`,
    )
  }

  return rules.join('\n')
}

/**
 * A theme may declare only these value fields. Everything else is preserved as legacy
 * by the save path, which is what keeps a theme change from deleting a customer's
 * previous answers.
 */
export const runtimeSettingAcceptsValue = (type: string, value: unknown): boolean => {
  if (type === RESPONSIVE_TYPOGRAPHY_TYPE) return isPlainObject(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'select' || type === 'text') return typeof value === 'string'
  return false
}

export type SplitStoredRuntimeSettings = {
  /** Declared settings whose stored value still matches their declared shape. */
  runtime: Record<string, unknown>
  /** Everything else: undeclared keys and declared keys whose type changed. */
  legacy: Record<string, unknown>
  /** Declared keys now held as legacy data; the form shows a preserved-value notice. */
  legacyDeclaredKeys: string[]
}

export const splitStoredRuntimeSettings = (
  settings: readonly { key: string; type: string }[],
  stored: unknown,
): SplitStoredRuntimeSettings => {
  const runtime: Record<string, unknown> = {}
  const legacy: Record<string, unknown> = {}
  const legacyDeclaredKeys: string[] = []
  if (!isPlainObject(stored)) return { legacy, legacyDeclaredKeys, runtime }

  const declared = new Map(settings.map((setting) => [setting.key, setting]))
  for (const [key, value] of Object.entries(stored)) {
    if (value === undefined || value === null) continue
    const setting = declared.get(key)
    if (!setting) {
      legacy[key] = value
      continue
    }
    if (runtimeSettingAcceptsValue(setting.type, value)) {
      runtime[key] = value
    } else {
      legacy[key] = value
      legacyDeclaredKeys.push(key)
    }
  }
  return { legacy, legacyDeclaredKeys, runtime }
}

/**
 * The version written into `runtimeSettingsMeta`. Bump when the meaning of a stored
 * value changes, not when a setting is added.
 */
export const THEME_SETTINGS_CONVERTER_VERSION = 1

export type RuntimeSettingsMeta = {
  /** Explicit settings written by the last runtime save (survives a theme change). */
  adoptedKeys?: string[]
  /** Still-valid settings held for a package that no longer declares them. */
  preservedLegacyKeys: string[]
  /** The package the values were last saved against. */
  packageId: string
  updatedAt: string
  version: number
}

/** A category with its sections, as the form renders it. */
export type RuntimeSettingCategoryGroup<T> = {
  category: SettingCategory
  count: number
  sections: {
    count: number
    key: string
    settings: T[]
  }[]
}

/**
 * Filter + group for the admin. Pure so the unit spec can assert that a 40-setting
 * theme collapses into categories and that a device switch (which is component state)
 * never changes this list.
 */
export const groupRuntimeSettings = <
  T extends {
    category?: null | SettingCategory
    help?: null | string
    key: string
    labelEn?: null | string
    labelFa?: null | string
    section?: null | string
    type: string
  },
>(
  settings: readonly T[],
  options: { query?: string } = {},
): RuntimeSettingCategoryGroup<T>[] => {
  const query = (options.query ?? '').trim().toLowerCase()
  const matching = settings.filter((setting) => {
    if (!query) return true
    const haystack = [
      setting.key,
      setting.labelEn ?? '',
      setting.labelFa ?? '',
      setting.help ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(query)
  })

  const byCategory = new Map<SettingCategory, Map<string, T[]>>()
  for (const setting of matching) {
    const category = settingCategory(setting)
    const section = (setting.section ?? 'general').toLowerCase()
    if (!byCategory.has(category)) byCategory.set(category, new Map())
    const sections = byCategory.get(category)!
    if (!sections.has(section)) sections.set(section, [])
    sections.get(section)!.push(setting)
  }

  return SETTING_CATEGORIES.flatMap((category) => {
    const sections = byCategory.get(category)
    if (!sections || sections.size === 0) return []
    const ordered = [...sections.entries()].sort(([a], [b]) =>
      a === 'general' ? -1 : b === 'general' ? 1 : a.localeCompare(b),
    )
    return [
      {
        category,
        count: [...sections.values()].reduce((total, list) => total + list.length, 0),
        sections: ordered.map(([key, list]) => ({
          count: list.length,
          key,
          settings: list,
        })),
      },
    ]
  })
}
