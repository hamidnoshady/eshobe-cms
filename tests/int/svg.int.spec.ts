// @vitest-environment node
//
// The SVG allowlist (`src/lib/svg.ts`). Pure — no database. The point of each refusal is
// that the *next* obfuscation of it is refused too, so the cases are shapes of attack,
// not exact strings to match.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  looksLikeSvg,
  MAX_SVG_BYTES,
  SVG_FILTER_LIMITS,
  validateSvgUpload,
} from '@/lib/svg'

const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${inner}</svg>`

const graphiteLogo = readFileSync(
  new URL('../fixtures/graphite-animated-logo.svg', import.meta.url),
  'utf8',
)

const refused = (svg: string) => {
  const result = validateSvgUpload(svg)
  expect(result.ok, svg).toBe(false)
  return result
}

const accepted = (svg: string) => {
  const result = validateSvgUpload(svg)
  expect(result.ok, result.ok ? '' : result.reason).toBe(true)
  return result
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

  it('accepts pathLength, which icon sets use for dash animation', () => {
    expect(
      validateSvgUpload(wrap('<path d="M0 0L10 10" pathLength="1" stroke-dasharray="1"/><circle r="4" pathLength="100"/>')).ok,
    ).toBe(true)
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
  ])('refuses %s', (_label, svg) => { refused(svg) })

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

  it('leaves a raster alone when its metadata embeds an SVG (C2PA content credentials)', () => {
    const icon = Buffer.from('caBX…image/svg+xml<svg width="716" height="716">', 'latin1')
    const signatures = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'),
      Buffer.from('\0\0\0\x1cftypavif', 'latin1'),
    ]
    for (const sig of signatures) {
      expect(looksLikeSvg({ data: Buffer.concat([sig, icon]), mimetype: 'image/png' })).toBe(false)
    }
    // Only a genuine signature counts: an SVG that merely mentions PNG is still an SVG.
    expect(looksLikeSvg({ data: Buffer.concat([Buffer.from('PNG '), svg]) })).toBe(true)
  })
})

describe('validateSvgUpload — the safe animated-logo subset', () => {
  const filterDoc = (filter: string, body = '') => wrap(`<defs>${filter}</defs>${body}`)
  const blurFilter = (attrs = '', children = '') =>
    `<filter id="blur" ${attrs}><feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b"/>${children}</filter>`

  it('accepts the checked-in Graphite fixture with its filter graph and CSS animation', () => {
    const result = accepted(graphiteLogo)
    if (result.ok) {
      // Refuse-don't-repair: the fixture has no comments or XML declaration to remove.
      expect(result.svg).toBe(graphiteLogo.trim())
      expect(result.svg).toContain('<filter id="motionSmear"')
      expect(result.svg).toContain('<feGaussianBlur in="SourceGraphic" stdDeviation="3.3 1.2"')
      expect(result.svg).toContain('<feMergeNode in="halo"/>')
      expect(result.svg).toContain('@keyframes settle')
      expect(result.svg).toContain('filter: url(#traceBloom)')
      expect(result.svg).toContain('filter="url(#traceBloom)"')
    }
  })

  it('accepts a blur/merge graph through both the presentation attribute and CSS filter', () => {
    const filter = `<filter id="bloom" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur in="SourceGraphic" stdDeviation="3.3" result="halo"/><feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    accepted(
      filterDoc(
        filter,
        '<path d="M0 0L10 10" filter="url(#bloom)"/><rect width="1" height="1" style="filter:url(#bloom);opacity:.5"/>',
      ),
    )
  })

  it('accepts CSS @keyframes, transforms, opacity, timing and custom properties', () => {
    accepted(wrap(`
      <style>
        .line { --delay: .4s; opacity: 0; transform-origin: 5px 5px; animation: draw 1s ease-out var(--delay) forwards; }
        @keyframes draw {
          from { stroke-dashoffset: 10; transform: translateY(4px) rotate(-2deg); }
          to { stroke-dashoffset: 0; transform: translateY(0) rotate(0deg); opacity: 1; }
        }
      </style>
      <path class="line" d="M0 0L10 10" stroke-dasharray="10"/>
    `))
  })

  it('accepts filter:none and distinguishes CSS animation from SMIL tags', () => {
    accepted(
      filterDoc(
        blurFilter(),
        '<path d="M0 0" filter="none" style="filter:none;animation:fade 1s forwards"/><style>@keyframes fade{from{opacity:0}to{opacity:1}}</style>',
      ),
    )
    refused(wrap('<animate attributeName="opacity" from="0" to="1"/>'))
    refused(wrap('<animateTransform attributeName="transform" type="rotate"/>'))
    refused(wrap('<set attributeName="visibility" to="hidden"/>'))
  })

  it.each([
    ['feImage', filterDoc('<filter id="f"><feImage href="https://evil.example/x.png"/></filter>')],
    ['feOffset', filterDoc('<filter id="f"><feOffset dx="1" dy="1"/></filter>')],
    ['feColorMatrix', filterDoc('<filter id="f"><feColorMatrix type="matrix" values="1"/></filter>')],
    ['foreignObject', wrap('<foreignObject><div>hi</div></foreignObject>')],
    ['script', wrap('<script>alert(1)</script>')],
    ['an event handler', wrap('<rect width="1" height="1" onload="alert(1)"/>')],
  ])('refuses unsupported primitive or active element: %s', (_label, svg) => { refused(svg) })

  it.each([
    [
      'a remote filter reference in an attribute',
      filterDoc(blurFilter(), '<path d="M0 0" filter="url(https://evil.example/x.svg#blur)"/>'),
    ],
    [
      'a protocol-relative filter reference in CSS',
      wrap('<style>.a{filter:url(//evil.example/f)}</style><path class="a" d="M0 0"/>'),
    ],
    [
      'a javascript url',
      wrap('<rect width="1" height="1" fill="url(javascript:alert(1))"/>'),
    ],
    ['a data url', wrap('<rect width="1" height="1" fill="url(data:text/html,x)"/>')],
    ['a missing filter id', wrap('<path d="M0 0" filter="url(#missing)"/>')],
    [
      'a filter reference to a gradient',
      filterDoc(
        '<linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient>',
        '<path d="M0 0" filter="url(#g)"/>',
      ),
    ],
    ['a missing paint id', wrap('<rect width="1" height="1" fill="url(#missing)"/>')],
    ['a missing clipPath id', wrap('<rect width="1" height="1" clip-path="url(#missing)"/>')],
    ['a missing use id', wrap('<use href="#missing"/>')],
    [
      'an in reference to a result from another filter',
      wrap('<defs><filter id="a"><feGaussianBlur in="SourceGraphic" stdDeviation="1" result="halo"/></filter><filter id="b"><feGaussianBlur in="halo" stdDeviation="1"/></filter></defs>'),
    ],
    [
      'a forward in reference',
      filterDoc('<filter id="f"><feGaussianBlur in="later" stdDeviation="1"/><feGaussianBlur in="SourceGraphic" stdDeviation="1" result="later"/></filter>'),
    ],
  ])('refuses %s', (_label, svg) => { refused(svg) })

  it.each([
    ['@import', wrap('<style>@import "https://evil.example/x.css";</style>')],
    ['@font-face', wrap('<style>@font-face{font-family:x;src:url(https://evil.example/x.woff)}</style>')],
    ['a network-fetching property', wrap('<style>.a{background-image:url(#g)}</style>')],
    ['a CSS blur function', wrap('<style>.a{filter:blur(100px)}</style>')],
    ['a CSS escape hiding a keyword', wrap('<style>.a{transform:\\75rl(https://evil.example/x)}</style>')],
    ['an entity-obfuscated value', wrap('<style>.a{fill:&#106;avascript:alert(1)}</style>')],
    ['markup inside a stylesheet', wrap('<style>.a{opacity:1}<script>alert(1)</script></style>')],
    ['expression()', wrap('<rect width="1" height="1" style="width:expression(alert(1))"/>')],
    ['behavior:', wrap('<rect width="1" height="1" style="behavior:url(#x)"/>')],
    ['-moz-binding', wrap('<style>.a{-moz-binding:url(https://evil.example/x.xml#x)}</style>')],
    ['a remote url inside keyframes', wrap('<style>@keyframes x{from{opacity:url(https://evil.example/x)}}}</style>')],
    ['a CSS comment hiding a rule', wrap('<style>.a{opacity:1}/*x*/@import "x";</style>')],
  ])('refuses dangerous CSS: %s', (_label, svg) => { refused(svg) })

  it.each([
    [
      'an oversized blur radius',
      filterDoc(`<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="${SVG_FILTER_LIMITS.maxStdDeviation + 1}"/></filter>`),
    ],
    [
      'an exponential blur radius',
      filterDoc('<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="1e9"/></filter>'),
    ],
    [
      'an oversized filter region',
      filterDoc(`<filter id="f" x="0" y="0" width="${SVG_FILTER_LIMITS.maxRegionPercent + 1}%" height="100%"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter>`),
    ],
    [
      'a non-positive filter size',
      filterDoc('<filter id="f" x="0" y="0" width="-1" height="100%"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter>'),
    ],
    [
      'too many primitives',
      filterDoc(`<filter id="f">${Array.from({ length: SVG_FILTER_LIMITS.maxPrimitivesPerFilter + 1 }, (_, index) => `<feGaussianBlur in="SourceGraphic" stdDeviation="1" result="r${index}"/>`).join('')}</filter>`),
    ],
    [
      'too many merge nodes',
      filterDoc(`<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="1" result="b"/><feMerge>${'<feMergeNode in="SourceGraphic"/>'.repeat(SVG_FILTER_LIMITS.maxMergeNodesPerFilter + 1)}</feMerge></filter>`),
    ],
    [
      'too many filters',
      wrap(`<defs>${Array.from({ length: SVG_FILTER_LIMITS.maxFilters + 1 }, (_, index) => `<filter id="f${index}"><feGaussianBlur in="SourceGraphic" stdDeviation="1" result="r"/></filter>`).join('')}</defs>`),
    ],
    [
      'a nested filter',
      filterDoc('<filter id="outer"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/><filter id="inner"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter></filter>'),
    ],
    [
      'a duplicate result name',
      filterDoc('<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="1" result="x"/><feGaussianBlur in="SourceGraphic" stdDeviation="1" result="x"/></filter>'),
    ],
    [
      'an unknown filterUnits',
      filterDoc('<filter id="f" filterUnits="screen"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter>'),
    ],
    [
      'an unknown edgeMode',
      filterDoc('<filter id="f"><feGaussianBlur in="SourceGraphic" stdDeviation="1" edgeMode="reflect"/></filter>'),
    ],
    [
      'an unknown color-interpolation-filters',
      filterDoc('<filter id="f" color-interpolation-filters="weird"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter>'),
    ],
  ])('refuses high-complexity or malformed filters: %s', (_label, svg) => { refused(svg) })

  it.each([
    [
      'a filter attribute on a filter element',
      filterDoc('<filter id="f" filter="url(#f)"><feGaussianBlur in="SourceGraphic" stdDeviation="1"/></filter>'),
    ],
    ['stdDeviation on a path', wrap('<path d="M0 0" stdDeviation="1"/>')],
    ['result on a path', wrap('<path d="M0 0" result="x"/>')],
    ['in on a path', wrap('<path d="M0 0" in="SourceGraphic"/>')],
    [
      'result on feMergeNode',
      filterDoc('<filter id="f"><feMerge><feMergeNode in="SourceGraphic" result="x"/></feMerge></filter>'),
    ],
    [
      'stdDeviation on feMerge',
      filterDoc('<filter id="f"><feMerge stdDeviation="2"><feMergeNode in="SourceGraphic"/></feMerge></filter>'),
    ],
    [
      'filterUnits on feGaussianBlur',
      filterDoc('<filter id="f"><feGaussianBlur filterUnits="objectBoundingBox" stdDeviation="1"/></filter>'),
    ],
  ])('refuses filter attributes outside their element: %s', (_label, svg) => { refused(svg) })

  it('enforces the 200 KB cap with an exact, structured reason', () => {
    const result = refused(wrap(`<desc>${'a'.repeat(MAX_SVG_BYTES)}</desc>`))
    if (!result.ok) {
      expect(result.code).toBe('svg-too-large')
      expect(result.reason).toContain('۲۰۰ کیلوبایت')
    }
  })

  it('keeps ordinary logos and local paint references working', () => {
    accepted(wrap(`
      <defs><linearGradient id="g"><stop offset="0" stop-color="#111"/><stop offset="1" stop-color="#eee"/></linearGradient><clipPath id="c"><rect width="10" height="10"/></clipPath></defs>
      <g clip-path="url(#c)"><path d="M0 0L10 10Z" fill="url(#g)"/></g><use href="#c"/>
    `))
  })
})


describe('validateSvgUpload — original Graphite animated logo regression', () => {
  // Exact 19,801-byte customer upload, not the simplified fixture above.
  const originalLogo = readFileSync(
    new URL('../fixtures/graphite-animated-logo-original.svg', import.meta.url),
    'utf8',
  )

  it('accepts original Graphite logo with blur, comments, clipping and reduced-motion styles', () => {
    // The checked-in fixture has no trailing newline; the upload wrapper added
    // one byte to the original attachment's reported size.
    expect(Buffer.byteLength(originalLogo, 'utf8')).toBe(19_800)
    const result = accepted(originalLogo)
    if (result.ok) {
      expect(result.svg).toContain('<filter id="motionSmear"')
      expect(result.svg).toContain('filter:blur(5px)')
      expect(result.svg).toContain('filter:blur(.5px)')
      expect(result.svg).toContain('@media(prefers-reduced-motion:reduce)')
      expect(result.svg).toContain('/* Unmodified original mark geometry')
      expect(result.svg).toContain('color-scheme:light dark')
      expect(result.svg).toContain('clip-path:inset(100% 0 0 0)')
      expect(result.svg).toContain('--clip-start:inset(0 100% 0 0)')
      expect(result.svg).toContain('r:5')
      expect(result.svg).not.toContain('<?xml')
    }
  })

  it('accepts standalone comments between CSS rules, preserving them as-is', () => {
    const svg = wrap('<style>/* first */.mark{fill:#111}\n/* second */.next{opacity:1}</style><path class="mark" d="M0 0"/>')
    const result = accepted(svg)
    if (result.ok) expect(result.svg).toContain('/* second */')
  })

  it('accepts a narrow reduced-motion fallback with !important', () => {
    accepted(wrap('<style>.mark{filter:blur(5px);clip-path:inset(-3% -3% -3% -3%)}@media (prefers-reduced-motion: reduce){.mark{animation:none!important;filter:none!important;opacity:1!important}}</style><path class="mark" d="M0 0"/>'))
  })

  it.each([
    ['a CSS comment splitting a property', '.mark{fi/* X */ll:red}'],
    ['a CSS comment splitting a selector', '.ma/* X */rk{fill:red}'],
    ['a CSS comment inside a declaration value', '.mark{fill:/* X */red}'],
    ['an unterminated CSS comment', '/* unclosed .mark{fill:red}'],
    ['a media query other than reduced motion', '@media (min-width: 1px){.mark{opacity:1}}'],
    ['a nested media query', '@media (prefers-reduced-motion: reduce){@media (prefers-reduced-motion: reduce){.mark{opacity:1}}}'],
    ['an unbounded blur radius', '.mark{filter:blur(21px)}'],
    ['a negative blur radius', '.mark{filter:blur(-1px)}'],
    ['a compound CSS blur chain', '.mark{filter:blur(5px) blur(2px)}'],
    ['an unsupported CSS blur argument', '.mark{filter:blur(var(--radius))}'],
    ['an unbounded inset region', '.mark{clip-path:inset(1001px)}'],
    ['external resources inside reduced motion', '@media(prefers-reduced-motion:reduce){.mark{filter:url(https://bad.example/a.svg)}}'],
    ['an unsupported @supports rule', '@supports (display:grid){.mark{opacity:1}}'],
    ['an arbitrary color-scheme value', ':root{color-scheme:url(#x)}'],
    ['malicious CSS @import', '@import url(https://bad.example/x.css);.mark{opacity:1}'],
  ])('still rejects %s', (_label, css) => {
    refused(wrap('<style>' + css + '</style><path class="mark" d="M0 0"/>'))
  })
})
