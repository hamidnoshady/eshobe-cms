import type { Theme } from '@/payload-types'

import { describe, expect, it } from 'vitest'

import { isHexColor, themeCss } from '@/lib/theme'

/**
 * `themeCss` writes editor-supplied values into a `<style>` tag and derives the text
 * colour that goes on top of them — an injection boundary and an accessibility
 * decision in eight lines, so both get asserted.
 */
const theme = (fields: Partial<Theme>): Theme => ({ id: 'x', site: 's', ...fields }) as Theme

describe('themeCss', () => {
  it('emits nothing without a theme document', () => {
    expect(themeCss(null)).toBe('')
  })

  it('re-declares the raw variables that @theme inline maps utilities to', () => {
    const css = themeCss(theme({ primary: '#0f766e', radius: 'lg' }))

    expect(css).toContain('--primary:#0f766e;')
    expect(css).toContain('--radius:1rem;')
  })

  it('drops a value that is not a hex colour instead of interpolating it', () => {
    // The attack this closes: an editor with access to one site's theme closing the
    // rule and rewriting the whole page's CSS.
    const css = themeCss(theme({ primary: 'red; } body { display: none } /*' }))

    expect(css).not.toContain('display')
    expect(css).not.toContain('red')
    expect(isHexColor('red')).toBe(false)
  })

  it('pairs a light brand colour with dark text and a dark one with light text', () => {
    // Amber with the palette's default white foreground is unreadable, and a brand
    // colour is chosen for a logo, not for contrast.
    expect(themeCss(theme({ primary: '#f59e0b' }))).toContain('--primary-foreground:oklch(14.5%')
    expect(themeCss(theme({ primary: '#0f766e' }))).toContain('--primary-foreground:oklch(98.5%')
  })

  it('reads three-digit hex the same as six', () => {
    expect(themeCss(theme({ primary: '#fff' }))).toContain('--primary-foreground:oklch(14.5%')
    expect(themeCss(theme({ primary: '#000' }))).toContain('--primary-foreground:oklch(98.5%')
  })

  it('keeps the site’s background out of dark mode', () => {
    // On `body` unconditionally, a site's white background would beat
    // `[data-theme='dark']` on `html` and the dark theme would do nothing.
    const css = themeCss(theme({ background: '#ffffff', primary: '#0f766e' }))

    expect(css).toMatch(/html:not\(\[data-theme='dark'\]\) body\{[^}]*--background:#ffffff/)
    expect(css.slice(0, css.indexOf('html:not'))).not.toContain('--background')
  })

  it('defaults line-height to the Persian 1.8, not the browser’s', () => {
    expect(themeCss(theme({}))).toContain('--line-height:1.8;')
    expect(themeCss(theme({ lineHeight: 2 }))).toContain('--line-height:2;')
  })
})
