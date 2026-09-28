import { isHexColor } from '@eshobe/site-runtime'

export const DESIGN_COLOR_KEYS = ['accent', 'background', 'foreground', 'primary'] as const
export type DesignColorKey = (typeof DESIGN_COLOR_KEYS)[number]

export const DESIGN_RADIUS = ['none', 'sm', 'md', 'lg'] as const
export type DesignRadius = (typeof DESIGN_RADIUS)[number]

export const DESIGN_LINE_HEIGHT_MIN = 1.4
export const DESIGN_LINE_HEIGHT_MAX = 2.4

export const DESIGN_TOKEN_KEYS = [...DESIGN_COLOR_KEYS, 'lineHeight', 'radius'] as const
export type DesignTokenKey = (typeof DESIGN_TOKEN_KEYS)[number]
export type DesignDefaults = Partial<
  {
    [K in DesignColorKey]: string
  } & {
    lineHeight: number
    radius: DesignRadius
  }
>

export const isDesignColor = (value: unknown): value is string => isHexColor(value)

export const isDesignRadius = (value: unknown): value is DesignRadius =>
  typeof value === 'string' && (DESIGN_RADIUS as readonly string[]).includes(value)

export const isDesignLineHeight = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= DESIGN_LINE_HEIGHT_MIN &&
  value <= DESIGN_LINE_HEIGHT_MAX

export const validateDesignColor = (value: unknown): string | true =>
  value === null || value === undefined || value === '' || isDesignColor(value)
    ? true
    : 'رنگ را به شکل کد هکس بنویسید، مثل #0f766e.'

export const validateDesignRadius = (value: unknown): string | true =>
  value === null || value === undefined || value === '' || isDesignRadius(value)
    ? true
    : 'مقدار گردی گوشه‌ها نامعتبر است.'

export const validateDesignLineHeight = (value: unknown): string | true =>
  value === null || value === undefined || value === '' || isDesignLineHeight(value)
    ? true
    : `فاصله خطوط باید بین ${DESIGN_LINE_HEIGHT_MIN} و ${DESIGN_LINE_HEIGHT_MAX} باشد.`

export const isDesignDefaults = (value: unknown): value is DesignDefaults => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tokens = value as Record<string, unknown>
  return Object.entries(tokens).every(([key, token]) => {
    if (!(DESIGN_TOKEN_KEYS as readonly string[]).includes(key)) return false
    if ((DESIGN_COLOR_KEYS as readonly string[]).includes(key)) return isDesignColor(token)
    if (key === 'radius') return isDesignRadius(token)
    if (key === 'lineHeight') return isDesignLineHeight(token)
    return false
  })
}

/**
 * Copies only the stable site-theme contract and validates each token independently.
 * Legacy catalogue rows and newer manifests may have fewer tokens than the current
 * site theme schema; missing values must never blank a customer's customization.
 */
export const recognizedDesignDefaults = (value: unknown): DesignDefaults => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const result: DesignDefaults = {}

  for (const key of DESIGN_COLOR_KEYS) {
    const candidate = raw[key]
    if (
      candidate !== undefined &&
      candidate !== null &&
      candidate !== '' &&
      isDesignColor(candidate)
    ) {
      result[key] = candidate
    }
  }

  if (isDesignLineHeight(raw.lineHeight)) result.lineHeight = raw.lineHeight
  if (isDesignRadius(raw.radius)) result.radius = raw.radius

  return result
}
