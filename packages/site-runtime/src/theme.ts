export type Theme = {
  primary?: string | null
  accent?: string | null
  background?: string | null
  foreground?: string | null
  radius?: 'lg' | 'md' | 'sm' | 'none' | null
  lineHeight?: number | null
}

/**
 * Per-site design tokens as a `<style>` body.
 *
 * Tailwind v4's `@theme inline` block in `globals.css` maps every utility token to a
 * raw variable (`--color-primary: var(--primary)`), so per-site theming is just
 * re-declaring those raw variables lower down the cascade. No per-tenant CSS build,
 * no rebuild when an editor saves.
 */

/**
 * `#rgb` or `#rrggbb`, and nothing else. These values are interpolated into a
 * `<style>` tag, so a stray `}` would let a site's editor rewrite the whole page's
 * CSS — an unvalidated value is dropped rather than emitted.
 */
export const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)

/** The `--radius` scale `globals.css` derives `--radius-sm|md|lg|xl` from. */
const RADIUS = { lg: '1rem', md: '0.625rem', none: '0', sm: '0.25rem' } as const

/** The near-black and near-white the rest of the palette already uses. */
const INK = 'oklch(14.5% 0 0deg)'
const PAPER = 'oklch(98.5% 0 0deg)'

/**
 * Black or white text, whichever reads on `hex`. A brand colour picked for a logo is
 * often far too light for the white the default palette pairs with `--primary`, and
 * that lands as unreadable buttons on every page of the site.
 *
 * WCAG relative luminance, thresholded where its contrast against black and white
 * crosses over.
 */
const readableOn = (hex: string): string => {
  const full =
    hex.length === 4
      ? hex
          .slice(1)
          .split('')
          .map((c) => c + c)
          .join('')
      : hex.slice(1)

  const channel = (offset: number): number => {
    const srgb = parseInt(full.slice(offset, offset + 2), 16) / 255

    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }

  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)

  return luminance > 0.179 ? INK : PAPER
}

/** A colour and the text that reads on it, or nothing if the value is not a hex. */
const pair = (name: string, value: unknown): string =>
  isHexColor(value) ? `--${name}:${value};--${name}-foreground:${readableOn(value)};` : ''

/** A colour on its own — for the two tokens that already name their own contrast. */
const decl = (name: string, value: unknown): string =>
  isHexColor(value) ? `--${name}:${value};` : ''

export const themeCss = (theme: null | Theme): string => {
  if (!theme) return ''

  const radius = RADIUS[theme.radius ?? 'md'] ?? RADIUS.md
  const leading = typeof theme.lineHeight === 'number' ? theme.lineHeight : 1.8

  const brand = `${pair('primary', theme.primary)}${pair('accent', theme.accent)}--radius:${radius};--line-height:${leading};`

  // ponytail: `--card`, `--muted` and `--border` keep the template's neutral ramp, so
  // a site on a dark background gets light cards. Derive the ramp from `background`
  // in oklch when a customer actually picks one.
  const paper = `${decl('background', theme.background)}${decl('foreground', theme.foreground)}`

  /**
   * `background` and `foreground` are the site's *light* palette, so they are scoped
   * away from dark mode — declared on `body` unconditionally they would override
   * `[data-theme='dark']` on `html` and a site with a white background would have no
   * dark theme at all. Brand colour and radius are direction- and mode-agnostic.
   */
  return `body{${brand}}${paper ? `html:not([data-theme='dark']) body{${paper}}` : ''}`
}
