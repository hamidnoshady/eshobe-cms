// @vitest-environment node
//
// The SVG allowlist (`src/lib/svg.ts`). Pure — no database. The point of each refusal is
// that the *next* obfuscation of it is refused too, so the cases are shapes of attack,
// not exact strings to match.
import { describe, expect, it } from 'vitest'

import { looksLikeSvg, MAX_SVG_BYTES, validateSvgUpload } from '@/lib/svg'

const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`

const refused = (svg: string) => {
  const result = validateSvgUpload(svg)
  expect(result.ok, svg).toBe(false)
}

describe('validateSvgUpload — what a logo is', () => {
  it('accepts a typical exported logo and returns it unchanged apart from the XML declaration and comments', () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 40" width="100" height="40">
  <title>لوگو</title>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#8c6f4a"/></linearGradient>
    <clipPath id="c"><rect width="100" height="40"/></clipPath>
    <style>.a{fill:url(#g);stroke:#000}</style>
  </defs>
  <g clip-path="url(#c)"><path class="a" d="M0 0L100 0L100 40Z" style="opacity:.9"/></g>
  <use href="#c"/>
  <text x="4" y="30" font-family="Vazirmatn">Graphite &amp; co</text>
</svg>`
    const result = validateSvgUpload(Buffer.from(source, 'utf8'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.svg.startsWith('<svg')).toBe(true)
      expect(result.svg).not.toContain('<?xml')
      expect(result.svg).not.toContain('<!--')
      expect(result.svg).toContain('d="M0 0L100 0L100 40Z"')
    }
  })

  it('accepts a self-closing root and single-quoted attributes', () => {
    expect(validateSvgUpload("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>").ok).toBe(true)
  })
})

describe('validateSvgUpload — what is refused', () => {
  it.each([
    ['a script element', wrap('<script>alert(1)</script>')],
    ['a script element, mixed case', wrap('<ScRiPt>alert(1)</ScRiPt>')],
    ['an onload handler', wrap('', ' onload="alert(1)"')],
    ['an onclick handler on a child', wrap('<rect onclick="x()" width="1" height="1"/>')],
    ['an unquoted handler-shaped attribute', wrap('<rect width=1/>')],
    ['a foreignObject', wrap('<foreignObject><div>hi</div></foreignObject>')],
    ['an image element', wrap('<image href="https://evil.example/x.png"/>')],
    ['an anchor', wrap('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ['an animate element', wrap('<animate attributeName="href" values="javascript:alert(1)"/>')],
    ['a set element', wrap('<set attributeName="onload" to="alert(1)"/>')],
    ['a use pointing off-document', wrap('<use href="https://evil.example/x.svg#a"/>')],
    ['a use with a javascript href', wrap('<use xlink:href="javascript:alert(1)"/>')],
    ['an href on a non-use element', wrap('<path href="#a" d="M0 0"/>')],
    ['an external url() paint', wrap('<rect fill="url(https://evil.example/p)" width="1" height="1"/>')],
    ['an external url() in a style attribute', wrap('<rect style="fill:url(//evil.example/p)" width="1" height="1"/>')],
    ['a CSS @import', wrap('<style>@import "https://evil.example/x.css";</style>')],
    ['a CSS escape hiding a keyword', wrap('<style>.a{background:\\75rl(x)}</style>')],
    ['a javascript: value', wrap('<rect width="javascript:alert(1)" height="1"/>')],
    ['a data: value', wrap('<rect fill="data:text/html,x" width="1" height="1"/>')],
    ['an entity in an attribute', wrap('<rect fill="&#106;avascript:alert(1)" width="1" height="1"/>')],
    ['an unknown attribute', wrap('<rect data-evil="1" width="1" height="1" xlink:role="x"/>')],
    ['a DOCTYPE', `<!DOCTYPE svg [<!ENTITY x "y">]>${wrap('')}`],
    ['a bare ENTITY', wrap('<!ENTITY x "y">')],
    ['CDATA', wrap('<style><![CDATA[.a{fill:red}]]></style>')],
    ['a processing instruction', `<?xml-stylesheet href="x.css"?>${wrap('')}`],
    ['text directly inside svg', wrap('hello')],
    ['markup inside text that is not well formed', wrap('<text><b>x</b></text>')],
    ['a stray angle bracket', wrap('<rect width="1" height="1"/ <script>')],
    ['content after the root closes', `${wrap('')}<script>alert(1)</script>`],
    ['an unclosed tag', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>'],
    ['a document that is not svg first', '<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>'],
    ['an empty file', ''],
    ['binary noise', '��'],
  ])('refuses %s', (_label, svg) => refused(svg))

  it('refuses a file over the size cap', () => {
    refused(wrap(`<desc>${'a'.repeat(MAX_SVG_BYTES)}</desc>`))
  })

  it('returns a reason a customer can act on', () => {
    const result = validateSvgUpload(wrap('<image href="x.png"/>'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('image')
  })
})

describe('looksLikeSvg', () => {
  const svg = Buffer.from(wrap(''), 'utf8')
  it('recognises an SVG by type, by name, and by content', () => {
    expect(looksLikeSvg({ mimetype: 'image/svg+xml' })).toBe(true)
    expect(looksLikeSvg({ name: 'Logo.SVG' })).toBe(true)
    // The uploader's label is not evidence: an SVG named .png is still an SVG.
    expect(looksLikeSvg({ data: svg, mimetype: 'image/png', name: 'logo.png' })).toBe(true)
  })

  it('leaves a real raster alone', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(looksLikeSvg({ data: png, mimetype: 'image/png', name: 'a.png' })).toBe(false)
  })
})
