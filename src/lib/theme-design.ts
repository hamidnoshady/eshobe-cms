import { isHexColor } from '@eshobe/site-runtime'

export const DESIGN_TOKEN_KEYS = ['accent', 'background', 'foreground', 'lineHeight', 'primary', 'radius'] as const
export type DesignTokenKey = (typeof DESIGN_TOKEN_KEYS)[number]
export type DesignDefaults = Partial<Record<DesignTokenKey, number | string>>

export const DESIGN_RADIUS = ['none', 'sm', 'md', 'lg'] as const

export const isDesignDefaults = (value: unknown): value is DesignDefaults => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const tokens = value as Record<string, unknown>
  return Object.entries(tokens).every(([key, token]) =>
    (DESIGN_TOKEN_KEYS as readonly string[]).includes(key) &&
    ((key === 'radius' && typeof token === 'string' && (DESIGN_RADIUS as readonly string[]).includes(token)) ||
      (key === 'lineHeight' && typeof token === 'number' && token >= 1.4 && token <= 2.4) ||
      (['accent', 'background', 'foreground', 'primary'] as string[]).includes(key) && isHexColor(token)),
  )
}

/** Copies only the stable site-theme contract; never forwards unknown manifest data. */
export const recognizedDesignDefaults = (value: unknown): DesignDefaults => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const result: DesignDefaults = {}
  for (const key of DESIGN_TOKEN_KEYS) {
    const candidate = raw[key]
    if (candidate !== undefined && candidate !== null && candidate !== '') result[key] = candidate as never
  }
  return isDesignDefaults(result) ? result : {}
}
