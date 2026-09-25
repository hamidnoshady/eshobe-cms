// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderThemeRoutes, writeThemeRoutes } from '@/lib/deploy/theme-routes.mjs'

/**
 * The Caddy map's renderer and writer — shared by the application and
 * `scripts/render-theme-routes.mjs` — without a database.
 *
 * The one property worth more than all the others: **a failure never truncates the
 * existing map.** An empty map written over a populated one takes every themed site
 * off its theme at once; a stale one costs one site a redeploy's worth of delay.
 */

const EXISTING = 'map {host} {theme_upstream} {\n\tdefault ""\n\tacme.ir acme-ir-bazaar.sites.example.com\n}\n'

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'theme-routes-core-'))
  file = join(dir, 'theme-routes.caddy')
  writeFileSync(file, EXISTING)
})

afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe('renderThemeRoutes', () => {
  it('renders a Caddy map with a fall-through default', () => {
    const { count, text } = renderThemeRoutes([
      { host: 'acme.ir', upstream: 'acme-ir-bazaar.sites.example.com' },
      { host: 'www.acme.ir', upstream: 'acme-ir-bazaar.sites.example.com' },
    ])
    expect(count).toBe(2)
    expect(text).toContain('map {host} {theme_upstream} {\n\tdefault ""\n\tacme.ir acme-ir-bazaar.sites.example.com\n')
    expect(text.trimEnd().endsWith('}')).toBe(true)
  })

  it('drops malformed and duplicate hosts rather than emitting them', () => {
    const { count, skipped, text } = renderThemeRoutes([
      { host: 'acme.ir', upstream: 'a.sites.example.com' },
      { host: 'acme.ir', upstream: 'b.sites.example.com' },
      { host: 'evil.ir } respond 200 {', upstream: 'x.sites.example.com' },
      { host: 'nodot', upstream: 'x.sites.example.com' },
    ])
    expect(count).toBe(1)
    expect(skipped).toHaveLength(3)
    expect(text).not.toContain('evil')
    expect(text).not.toContain('b.sites.example.com')
  })

  it('refuses a malformed input shape instead of rendering an empty map', () => {
    expect(() => renderThemeRoutes(null)).toThrow()
    expect(() => renderThemeRoutes({ routes: [] })).toThrow()
  })
})

describe('writeThemeRoutes', () => {
  it('replaces the file atomically and leaves no temporary behind', () => {
    const { text } = renderThemeRoutes([{ host: 'shop.ir', upstream: 'shop-ir-x.sites.example.com' }])
    expect(writeThemeRoutes(file, text)).toBe('written')
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(spawnSync('ls', [dir]).stdout.toString().trim()).toBe('theme-routes.caddy')
  })

  it('does not rewrite a map whose routes did not change', () => {
    const first = renderThemeRoutes([{ host: 'shop.ir', upstream: 'u.sites.example.com' }], { generatedAt: 'one' })
    writeThemeRoutes(file, first.text)
    const before = statSync(file).mtimeMs
    const second = renderThemeRoutes([{ host: 'shop.ir', upstream: 'u.sites.example.com' }], { generatedAt: 'two' })
    expect(writeThemeRoutes(file, second.text)).toBe('unchanged')
    expect(statSync(file).mtimeMs).toBe(before)
  })

  it('leaves the existing map untouched when the write cannot happen', () => {
    expect(() => writeThemeRoutes(join(dir, 'missing', 'theme-routes.caddy'), 'x')).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(EXISTING)
  })
})

describe('scripts/render-theme-routes.mjs', () => {
  const script = resolve(process.cwd(), 'scripts/render-theme-routes.mjs')

  it('exits non-zero without touching the map when the CMS is unreachable', () => {
    const run = spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
      env: { ...process.env, CMS_URL: 'http://127.0.0.1:1', PLATFORM_API_KEY: 'eshobe_live_test' },
      timeout: 30_000,
    })
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('render-theme-routes')
    expect(readFileSync(file, 'utf8')).toBe(EXISTING)
  })

  it('refuses to run without its two inputs', () => {
    const run = spawnSync(process.execPath, [script, file], {
      encoding: 'utf8',
      env: { ...process.env, CMS_URL: '', PLATFORM_API_KEY: '' },
      timeout: 30_000,
    })
    expect(run.status).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(EXISTING)
  })
})
