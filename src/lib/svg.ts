/**
 * Accepting an SVG upload without accepting its script.
 *
 * An SVG is a document, not a picture: it can carry `<script>`, event handlers, HTML in
 * `<foreignObject>`, external fetches and CSS that reaches out. `/api/media/file/*` serves
 * uploads from the customer's own origin, so an unchecked SVG is stored XSS. `Media`
 * therefore stayed raster-only until there was a pipeline like this one (its comment says
 * so), and this is that pipeline.
 *
 * ## Allowlist, and refuse rather than repair
 *
 * A denylist ("strip `<script>`") loses to the next obfuscation. This does the opposite:
 * it walks the document tag by tag and accepts only elements and attributes on a short
 * list of *drawing* vocabulary — shapes, paths, groups, gradients, clips, masks, `use`
 * of a local `#id`, text and a restricted `<style>`. Anything else — an unknown element,
 * an unknown attribute, any `on*`, a reference that leaves the document, an entity, a
 * `DOCTYPE`, a processing instruction, CDATA — **rejects the upload with a reason**. It
 * never silently rewrites markup it did not understand, because bytes that were parsed
 * one way and stored another are exactly the gap a filter bypass lives in. The only edit
 * made is removing comments and the XML declaration, which carry nothing; what is
 * returned is what was validated.
 *
 * ## The one deliberate widening: animated vector branding
 *
 * A lightweight logo can legitimately need construction/reveal animation and a subtle
 * motion blur. That is admitted as a *small, explicit graph*, not as "SVG animation":
 *
 * - Elements: `filter`, `feGaussianBlur`, `feMerge`, `feMergeNode`. No `feImage`, no
 *   other primitive, no SMIL (`animate`, `set`, `animateTransform`, …) and no `<image>`.
 * - References: `filter="url(#id)"` and CSS `filter: url(#id)` must point at a `<filter>`
 *   declared in this document. Every `url(#id)` is local and its target is checked for
 *   both existence and the kind of element the property expects. Remote `url(...)`,
 *   `href` outside a local `#id`, `javascript:`/`data:`/CSS escapes and entities stay out.
 * - CSS: a declaration-property allowlist with `@keyframes`, transforms, opacity, timing
 *   and custom properties. `@import`, `@font-face`, network-fetching properties,
 *   `expression()`, `-moz-binding`, CSS escapes and comments are refused — not stripped.
 * - Bounds: blur radius, filter region, filter count, primitive/merge-node counts,
 *   filter references, keyframes and declarations (see `src/lib/svgLimits.ts`). Filter
 *   primitives must be direct children of a `<filter>`, merge nodes of `<feMerge>`, and
 *   filters may not nest. A filter's `in` may name a built-in source or a `result`
 *   produced earlier in the *same* filter.
 *
 * Defence in depth stays intact: Payload's own `validateSvg` runs afterwards on the
 * result, the local file route answers uploads with `script-src 'none'; frame-src 'none';
 * object-src 'none'` and the object-storage handler does the same. The admin previews and
 * the public renderer use the original SVG URL, never a rasterized size, so the CSS
 * keyframes actually run. An SVG that uses anything outside this vocabulary is still
 * refused with a reason, and the customer re-exports it — nothing is repaired.
 */

import {
  MAX_SVG_BYTES,
  SVG_FILTER_LIMITS,
  type SvgErrorCode,
} from '@/lib/svgLimits'

export { MAX_SVG_BYTES, SVG_FILTER_LIMITS } from '@/lib/svgLimits'
export type { SvgErrorCode } from '@/lib/svgLimits'

const {
  maxCssDeclarations,
  maxFilterReferences,
  maxFilters,
  maxKeyframes,
  maxMergeNodesPerFilter,
  maxMergeNodesTotal,
  maxPrimitivesPerFilter,
  maxPrimitivesTotal,
  maxRegionPercent,
  maxRegionUserUnits,
  maxStdDeviation,
} = SVG_FILTER_LIMITS

const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'style',
  // The four filter elements are the whole filter vocabulary. Everything else —
  // feImage, feOffset, feColorMatrix, SMIL animation — is refused by default.
  'filter',
  'fegaussianblur',
  'femerge',
  'femergenode',
])

const FILTER_ELEMENTS = new Set(['filter', 'fegaussianblur', 'femerge', 'femergenode'])
const PAINT_ELEMENTS = new Set(['lineargradient', 'radialgradient', 'pattern'])
const SOURCE_INPUTS = new Set([
  'SourceGraphic',
  'SourceAlpha',
  'BackgroundImage',
  'BackgroundAlpha',
  'FillPaint',
  'StrokePaint',
])

/** Elements whose character data is meaningful. Everywhere else, text is whitespace. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc', 'style'])

const ATTRIBUTES = new Set([
  'id',
  'class',
  'style',
  'xmlns',
  'xmlns:xlink',
  'version',
  'viewbox',
  'preserveaspectratio',
  'xml:space',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'dx',
  'dy',
  'd',
  'points',
  // Normalises dash lengths on a path (line-draw icons). Geometry only, no reference.
  'pathlength',
  'transform',
  'offset',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'mask',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'clippathunits',
  'maskunits',
  'maskcontentunits',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'shape-rendering',
  'vector-effect',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'text-decoration',
  'dominant-baseline',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-labelledby',
  'focusable',
  'data-name',
  'href',
  'xlink:href',
  // Safe filter subset. `filter` is the presentation attribute on a drawing element;
  // the rest are only legal on the filter elements checked below.
  'filter',
  'filterunits',
  'primitiveunits',
  'color-interpolation-filters',
  'stddeviation',
  'in',
  'result',
  'edgemode',
])

/** Filter-only attributes, with the exact element each is allowed on. */
const FILTER_ONLY_ELEMENTS: Record<string, Set<string>> = {
  filterunits: new Set(['filter']),
  primitiveunits: new Set(['filter']),
  'color-interpolation-filters': new Set(['filter', 'fegaussianblur', 'femerge']),
  stddeviation: new Set(['fegaussianblur']),
  edgemode: new Set(['fegaussianblur']),
  in: new Set(['fegaussianblur', 'femerge', 'femergenode']),
  result: new Set(['fegaussianblur', 'femerge']),
}
const FILTER_ONLY_ATTRIBUTES = new Set(Object.keys(FILTER_ONLY_ELEMENTS))

/** Attributes whose value may be a `url(#id)` (or a plain colour / `none`). */
const URL_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path', 'mask', 'filter'])

/** A tag, in one anchored piece: `<name attr="v" attr='v' flag />` or `</name>`. */
const TAG =
  /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'))?)*)\s*(\/?)>/y
const ATTR = /\s+([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"<]*)"|'([^'<]*)'))?/g

/** A local reference: `url(#id)` or `url('#id')`, with optional inner whitespace. */
const URL_REF = /\burl\(\s*(['"]?)#([A-Za-z0-9_.:-]+)\1\s*\)/gi
const URL_REF_ONLY = /^\s*url\(\s*(['"]?)#([A-Za-z0-9_.:-]+)\1\s*\)\s*$/i
const ANY_URL = /\burl\s*\(/i
const ID_RE = /^[A-Za-z0-9_.:-]+$/
const FILTER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/
const NONE_ONLY = /^\s*none\s*$/i
const FILTER_UNITS = /^(?:objectboundingbox|userspaceonuse)$/i
const COLOR_INTERPOLATION = /^(?:auto|srgb|linearrgb)$/i
const EDGE_MODE = /^(?:duplicate|wrap|none)$/i
const FILTER_LENGTH = /^([+-]?\d+(?:\.\d+)?)(%)?$/
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Values that reach out of the document or execute, in any casing or spacing. */
const BAD_VALUE =
  /javascript:|vbscript:|data:|expression\s*\(|-moz-binding|behavior\s*:|@import|@font-face|@namespace|@document|image-set\s*\(|element\s*\(|-moz-element\s*\(|cross-fade\s*\(|[\\]/i

const SAFE_PAINT_VALUE = /^[\p{L}\p{N}\s#%.,()+\-/]+$/u
const SAFE_CSS_VALUE = /^[\p{L}\p{N}\s#%.,:+\-_()/"'!*]+$/u
const SAFE_SELECTOR = /^[\p{L}\p{N}\s#%.,:+\-_()\[\]="'~>*!|$^]+$/u
const KEYFRAMES_AT_RULE = /^@(?:-webkit-)?keyframes\s+([A-Za-z_][A-Za-z0-9_-]*)\s*$/i
const KEYFRAME_SELECTOR =
  /^(?:from|to|\d+(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d+(?:\.\d+)?%))*$/i
const CSS_DECLARATION = /^\s*(--[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9-]*)\s*:\s*([\s\S]*?)\s*$/

/** Painting, geometry and animation properties. Deliberately no `background*`, `src`, `cursor`, `content`, … */
const CSS_PROPERTIES = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'display',
  'visibility',
  'clip-path',
  'clip-rule',
  'mask',
  'stop-color',
  'stop-opacity',
  'shape-rendering',
  'vector-effect',
  'paint-order',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'text-decoration',
  'dominant-baseline',
  'transform',
  'transform-origin',
  'transform-box',
  'filter',
  'color-interpolation-filters',
  'flood-color',
  'flood-opacity',
  'isolation',
  'mix-blend-mode',
  'animation',
  'animation-name',
  'animation-duration',
  'animation-timing-function',
  'animation-delay',
  'animation-iteration-count',
  'animation-direction',
  'animation-fill-mode',
  'animation-play-state',
  'transition',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'will-change',
  'offset-distance',
  'offset-rotate',
])

/** No `expression`, `image-set`, `element`, `attr`, `blur`, `drop-shadow`, … */
const CSS_FUNCTIONS = new Set([
  'var',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'cubic-bezier',
  'steps',
  'calc',
  'min',
  'max',
  'clamp',
  'translate',
  'translatex',
  'translatey',
  'translatez',
  'translate3d',
  'scale',
  'scalex',
  'scaley',
  'scalez',
  'scale3d',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'skew',
  'skewx',
  'skewy',
  'matrix',
  'matrix3d',
  'perspective',
])

type RefKind = 'any' | 'filter' | 'clippath' | 'mask' | 'paint'
type SvgRef = { expects: RefKind; id: string }
type CssState = {
  declarations: number
  filterUses: number
  keyframes: number
  refs: SvgRef[]
}

export type SvgResult =
  | { code: SvgErrorCode; feature?: string; ok: false; reason: string }
  | { ok: true; svg: string }

const reject = (reason: string, code: SvgErrorCode, feature?: string): SvgResult => ({
  ok: false,
  reason,
  code,
  ...(feature ? { feature } : {}),
})

/** `url(...)` may only point at an id inside this same document. */
const localUrlRefs = (value: string): string[] | null => {
  const refs: string[] = []
  const rest = value.replace(URL_REF, (_match, _quote, id: string) => {
    refs.push(id)
    return ''
  })
  return ANY_URL.test(rest) ? null : refs
}

const filterLengthIsSafe = (value: string, isSize: boolean): boolean => {
  const match = FILTER_LENGTH.exec(value.trim())
  if (!match) return false
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return false
  if (Math.abs(amount) > (match[2] ? maxRegionPercent : maxRegionUserUnits)) return false
  return !isSize || amount > 0
}

const stdDeviationIsSafe = (value: string): boolean => {
  const parts = value.trim().split(/[\s,]+/).filter(Boolean)
  return (
    parts.length >= 1 &&
    parts.length <= 2 &&
    parts.every((part) => /^\d+(?:\.\d+)?$/.test(part) && Number(part) <= maxStdDeviation)
  )
}

const isSafeSelector = (selector: string): boolean =>
  selector.length > 0 &&
  selector.length <= 512 &&
  SAFE_SELECTOR.test(selector) &&
  !ANY_URL.test(selector) &&
  !BAD_VALUE.test(selector)

const splitDeclarations = (text: string): string[] | null => {
  const parts: string[] = []
  let current = ''
  let quote: null | string = null
  let depth = 0

  for (const character of text) {
    if (quote) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth < 0) return null
    }
    if (character === ';' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (quote || depth !== 0) return null
  parts.push(current)
  return parts
}

const validateCssValue = (property: string, value: string, state: CssState): boolean => {
  if (value.length > 512 || !SAFE_CSS_VALUE.test(value)) return false
  if (BAD_VALUE.test(value) || /@/.test(value)) return false
  const refs = localUrlRefs(value)
  if (!refs) return false

  if (property === 'filter') {
    if (NONE_ONLY.test(value)) return true
    const single = URL_REF_ONLY.exec(value)
    if (!single || refs.length !== 1) return false
    if (++state.filterUses > maxFilterReferences) return false
    state.refs.push({ expects: 'filter', id: single[2]! })
    return true
  }

  if (refs.length) {
    const single = URL_REF_ONLY.exec(value)
    if (!single || refs.length !== 1) return false
    const expects: RefKind =
      property === 'clip-path'
        ? 'clippath'
        : property === 'mask'
          ? 'mask'
          : property === 'fill' || property === 'stroke'
            ? 'paint'
            : 'any'
    state.refs.push({ expects, id: single[2]! })
  }

  // Every function call in a CSS value is named. `url` was handled above; a name
  // outside this set is a network-fetching / legacy-execution risk, not a value.
  for (const match of value.matchAll(/([A-Za-z][A-Za-z0-9-]*)\s*\(/g)) {
    const fn = match[1]!.toLowerCase()
    if (fn !== 'url' && !CSS_FUNCTIONS.has(fn)) return false
  }
  return true
}

const validateCssDeclarations = (
  text: string,
  state: CssState,
  allowDeclarations: boolean,
): boolean => {
  if (!allowDeclarations && text.trim() !== '') return false
  const parts = splitDeclarations(text)
  if (!parts) return false

  for (const part of parts) {
    if (!part.trim()) continue
    const declaration = CSS_DECLARATION.exec(part)
    if (!declaration) return false
    const property = declaration[1]!.toLowerCase()
    if (!property.startsWith('--') && !CSS_PROPERTIES.has(property)) return false
    if (++state.declarations > maxCssDeclarations) return false
    if (!validateCssValue(property, declaration[2]!, state)) return false
  }
  return true
}

/** A `<style>` body or `style=""` value: declarations + `@keyframes`, nothing that fetches. */
const cssIsSafe = (css: string, state: CssState): boolean => {
  if (/[&<\\\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(css)) return false
  // A CSS comment could hide a brace, a keyword or a second rule from this scanner.
  if (/\/\*|\*\//.test(css)) return false
  if (BAD_VALUE.test(css)) return false
  if (localUrlRefs(css) === null) return false

  type Frame = 'keyframe' | 'keyframes' | 'root' | 'rule'
  const frames: Frame[] = ['root']
  let buffer = ''
  let quote: null | string = null

  for (const character of css) {
    if (quote) {
      buffer += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      buffer += character
      continue
    }
    if (character === '{') {
      const prelude = buffer.trim()
      const parent = frames[frames.length - 1]!
      if (parent === 'root') {
        if (KEYFRAMES_AT_RULE.test(prelude)) {
          if (++state.keyframes > maxKeyframes) return false
          frames.push('keyframes')
        } else if (isSafeSelector(prelude)) {
          frames.push('rule')
        } else {
          return false
        }
      } else if (parent === 'keyframes') {
        if (!KEYFRAME_SELECTOR.test(prelude) || prelude.length > 128) return false
        frames.push('keyframe')
      } else {
        return false
      }
      buffer = ''
      continue
    }
    if (character === '}') {
      const frame = frames.pop()
      if (!frame || frame === 'root') return false
      if (!validateCssDeclarations(buffer, state, frame === 'rule' || frame === 'keyframe')) {
        return false
      }
      buffer = ''
      continue
    }
    buffer += character
  }

  if (quote || frames.length !== 1) return false
  return validateCssDeclarations(buffer, state, true)
}

const checkUrlAttribute = (
  attrName: string,
  rawName: string,
  value: string,
  state: CssState,
): SvgResult | null => {
  const refs = localUrlRefs(value)
  if (!refs) {
    return reject('ارجاع url() در SVG باید به شناسه‌ای در همین سند اشاره کند.', 'svg-invalid-reference', rawName)
  }
  if (refs.length > 1) {
    return reject(`مقدار ویژگی «${rawName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawName)
  }
  if (refs.length === 1) {
    const single = URL_REF_ONLY.exec(value)
    if (!single) {
      return reject(`مقدار ویژگی «${rawName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawName)
    }
    const expects: RefKind =
      attrName === 'filter'
        ? 'filter'
        : attrName === 'clip-path'
          ? 'clippath'
          : attrName === 'mask'
            ? 'mask'
            : 'paint'
    state.refs.push({ expects, id: single[2]! })
    if (expects === 'filter' && ++state.filterUses > maxFilterReferences) {
      return reject('تعداد ارجاع‌های فیلتر در SVG بیش از حد مجاز است.', 'svg-too-complex', rawName)
    }
    return null
  }
  if (attrName === 'filter' || attrName === 'clip-path' || attrName === 'mask') {
    if (!NONE_ONLY.test(value)) {
      return reject(`مقدار ویژگی «${rawName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawName)
    }
  } else if (!SAFE_PAINT_VALUE.test(value)) {
    return reject(`مقدار ویژگی «${rawName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawName)
  }
  return null
}

const checkAttributeValue = (
  attrName: string,
  rawName: string,
  value: string,
  state: CssState,
): SvgResult | null => {
  if (BAD_VALUE.test(value) || UNSAFE_CONTROL.test(value) || value.includes('&')) {
    return reject(`مقدار ویژگی «${rawName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawName)
  }
  const refs = localUrlRefs(value)
  if (!refs) {
    return reject('ارجاع url() در SVG باید به شناسه‌ای در همین سند اشاره کند.', 'svg-invalid-reference', rawName)
  }
  if (refs.length && !URL_ATTRIBUTES.has(attrName)) {
    return reject(`مقدار ویژگی «${rawName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawName)
  }
  if (URL_ATTRIBUTES.has(attrName)) return checkUrlAttribute(attrName, rawName, value, state)
  return null
}

type FilterState = { mergeNodes: number; primitives: number; results: Set<string> }
type StackEntry = { filter?: FilterState; name: string }

const nearestFilter = (stack: StackEntry[]): FilterState | undefined => {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!.name === 'filter') return stack[index]!.filter
  }
  return undefined
}

/**
 * Validate an uploaded SVG. On success `svg` is the text to store: the input with its
 * comments and XML declaration removed, trimmed, nothing else changed.
 */
export const validateSvgUpload = (input: Buffer | string): SvgResult => {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input.length
  if (bytes === 0) return reject('فایل SVG خالی است.', 'svg-empty')
  if (bytes > MAX_SVG_BYTES) {
    return reject('فایل SVG بزرگتر از ۲۰۰ کیلوبایت است.', 'svg-too-large')
  }

  let text = typeof input === 'string' ? input : input.toString('utf8')
  // A byte-order mark or replacement characters mean this was not UTF-8 text.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.includes('�') || text.includes('\0')) {
    return reject('فایل SVG باید متن UTF-8 معتبر باشد.', 'svg-invalid-utf8')
  }

  // Nothing but the drawing may remain: no DTD, no entity, no processing instruction,
  // no CDATA. Rejected outright rather than stripped — see the file header.
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) {
    return reject('SVG شامل DOCTYPE، ENTITY یا CDATA است.', 'svg-forbidden-markup')
  }

  // The two things that carry nothing: comments, and one leading XML declaration.
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  if (text.includes('<!--') || text.includes('-->')) {
    return reject('SVG شامل توضیح ناقص است.', 'svg-invalid-comment')
  }
  text = text.trim().replace(/^<\?xml\s[^>?]*\?>\s*/i, '').trim()
  if (text.includes('<?')) {
    return reject('SVG شامل دستور پردازشی (processing instruction) است.', 'svg-forbidden-markup')
  }

  if (!/^<svg[\s>]/i.test(text) || !/(?:<\/svg\s*|\/)>$/i.test(text)) {
    return reject('فایل با <svg> شروع و با </svg> تمام نمی‌شود.', 'svg-invalid-root')
  }

  const ids = new Map<string, string>()
  const state: CssState = { declarations: 0, filterUses: 0, keyframes: 0, refs: [] }
  const stack: StackEntry[] = []
  let pos = 0
  let rootClosed = false
  let filterCount = 0
  let primitiveTotal = 0
  let mergeNodeTotal = 0

  while (pos < text.length) {
    if (text[pos] !== '<') {
      // Character data up to the next tag.
      const next = text.indexOf('<', pos)
      const chunk = text.slice(pos, next === -1 ? text.length : next)
      const parent = stack[stack.length - 1]?.name
      if (chunk.trim() !== '') {
        if (rootClosed || !parent || !TEXT_ELEMENTS.has(parent)) {
          return reject('SVG شامل متن در جای غیرمجاز است.', 'svg-invalid-text')
        }
        if (parent === 'style') {
          if (!cssIsSafe(chunk, state)) {
            return reject('استایل داخل SVG غیرمجاز است.', 'svg-invalid-css')
          }
        } else if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(chunk)) {
          return reject('SVG شامل entity ناشناخته است.', 'svg-invalid-entity')
        }
      }
      pos = next === -1 ? text.length : next
      continue
    }

    TAG.lastIndex = pos
    const match = TAG.exec(text)
    // A `<` that does not begin a well-formed tag is not something to guess about.
    if (!match) return reject('SVG شامل نشانهگذاری نامعتبر است.', 'svg-invalid-markup')
    pos = TAG.lastIndex

    const [, closing, rawName, rawAttrs, selfClosing] = match
    const name = rawName!.toLowerCase()
    if (!ELEMENTS.has(name)) {
      return reject(`عنصر «${rawName}» در SVG مجاز نیست.`, 'svg-invalid-element', rawName)
    }
    if (rootClosed) return reject('SVG بعد از پایان عنصر اصلی محتوا دارد.', 'svg-invalid-root')

    if (closing) {
      if (rawAttrs!.trim() !== '' || selfClosing) {
        return reject('تگ پایانی SVG نامعتبر است.', 'svg-invalid-markup')
      }
      if (stack.pop()?.name !== name) {
        return reject('تگهای SVG درست بسته نشدهاند.', 'svg-unclosed')
      }
      if (stack.length === 0) rootClosed = true
      continue
    }

    const parent = stack[stack.length - 1]
    if (parent && FILTER_ELEMENTS.has(parent.name)) {
      const allowed =
        parent.name === 'filter'
          ? name === 'fegaussianblur' || name === 'femerge'
          : parent.name === 'femerge'
            ? name === 'femergenode'
            : false
      if (!allowed) {
        return reject('ساختار فیلتر SVG نامعتبر است.', 'svg-invalid-structure', rawName)
      }
    }

    let entry: StackEntry = { name }
    let filterState: FilterState | undefined
    if (FILTER_ELEMENTS.has(name)) {
      filterState = nearestFilter(stack)
      if (name === 'filter') {
        if (stack.some((item) => FILTER_ELEMENTS.has(item.name))) {
          return reject('فیلترهای تودرتو در SVG مجاز نیستند.', 'svg-too-complex', rawName)
        }
        filterCount += 1
        if (filterCount > maxFilters) {
          return reject('تعداد فیلترهای SVG بیش از حد مجاز است.', 'svg-too-complex', rawName)
        }
        entry = {
          filter: { mergeNodes: 0, primitives: 0, results: new Set<string>() },
          name,
        }
      } else if (name === 'femergenode') {
        if (parent?.name !== 'femerge' || !filterState) {
          return reject('ساختار فیلتر SVG نامعتبر است.', 'svg-invalid-structure', rawName)
        }
        filterState.mergeNodes += 1
        mergeNodeTotal += 1
        if (filterState.mergeNodes > maxMergeNodesPerFilter || mergeNodeTotal > maxMergeNodesTotal) {
          return reject('تعداد گرههای ترکیب فیلتر بیش از حد مجاز است.', 'svg-too-complex', rawName)
        }
      } else {
        if (parent?.name !== 'filter' || !parent.filter) {
          return reject('ساختار فیلتر SVG نامعتبر است.', 'svg-invalid-structure', rawName)
        }
        parent.filter.primitives += 1
        primitiveTotal += 1
        if (
          parent.filter.primitives > maxPrimitivesPerFilter ||
          primitiveTotal > maxPrimitivesTotal
        ) {
          return reject('تعداد عملیات فیلتر SVG بیش از حد مجاز است.', 'svg-too-complex', rawName)
        }
      }
    }

    const seen = new Set<string>()
    let inValue: string | undefined
    let resultValue: string | undefined
    let stdDeviationValue: string | undefined
    let filterUnitsValue: string | undefined
    let primitiveUnitsValue: string | undefined
    let colorInterpolationValue: string | undefined
    let edgeModeValue: string | undefined

    ATTR.lastIndex = 0
    for (let attr = ATTR.exec(rawAttrs!); attr; attr = ATTR.exec(rawAttrs!)) {
      const attrName = attr[1]!.toLowerCase()
      const rawAttrName = attr[1]!
      const value = attr[2] ?? attr[3] ?? ''
      if (seen.has(attrName)) {
        return reject(`ویژگی «${rawAttrName}» تکراری است.`, 'svg-invalid-attribute', rawAttrName)
      }
      seen.add(attrName)
      if (attrName.startsWith('on') || !ATTRIBUTES.has(attrName)) {
        return reject(`ویژگی «${rawAttrName}» در SVG مجاز نیست.`, 'svg-invalid-attribute', rawAttrName)
      }
      if (attrName === 'filter' && FILTER_ELEMENTS.has(name)) {
        return reject(`ویژگی «${rawAttrName}» در SVG مجاز نیست.`, 'svg-invalid-attribute', rawAttrName)
      }
      if (FILTER_ONLY_ATTRIBUTES.has(attrName) && !FILTER_ONLY_ELEMENTS[attrName]!.has(name)) {
        return reject(`ویژگی «${rawAttrName}» در SVG مجاز نیست.`, 'svg-invalid-attribute', rawAttrName)
      }

      if (attrName === 'style') {
        if (!cssIsSafe(value, state)) {
          return reject('ویژگی style در SVG غیرمجاز است.', 'svg-invalid-css', rawAttrName)
        }
      } else {
        const failure = checkAttributeValue(attrName, rawAttrName, value, state)
        if (failure) return failure
      }

      if (attrName === 'id') {
        if (!ID_RE.test(value) || ids.has(value)) {
          return reject(`مقدار ویژگی «${rawAttrName}» در SVG غیرمجاز است.`, 'svg-invalid-value', rawAttrName)
        }
        ids.set(value, name)
      }
      if (attrName === 'href' || attrName === 'xlink:href') {
        // `use` may reference a shape in this document; nothing may fetch anything.
        if (name !== 'use' || !/^#[A-Za-z0-9_.:-]+$/.test(value)) {
          return reject('ارجاع خارج از سند (href) در SVG مجاز نیست.', 'svg-invalid-reference', rawAttrName)
        }
        state.refs.push({ expects: 'any', id: value.slice(1) })
      }
      if (FILTER_ELEMENTS.has(name) && (attrName === 'x' || attrName === 'y' || attrName === 'width' || attrName === 'height')) {
        if (!filterLengthIsSafe(value, attrName === 'width' || attrName === 'height')) {
          return reject(
            `مقدار ویژگی «${rawAttrName}» در فیلتر SVG غیرمجاز است.`,
            'svg-invalid-value',
            rawAttrName,
          )
        }
      }
      if (attrName === 'in') inValue = value
      if (attrName === 'result') resultValue = value
      if (attrName === 'stddeviation') stdDeviationValue = value
      if (attrName === 'filterunits') filterUnitsValue = value
      if (attrName === 'primitiveunits') primitiveUnitsValue = value
      if (attrName === 'color-interpolation-filters') colorInterpolationValue = value
      if (attrName === 'edgemode') edgeModeValue = value
    }

    // `in` names a built-in source or a result from an earlier primitive in this
    // filter; `result` then registers a new name for later primitives. Attribute
    // order must not be able to turn a forward reference into a valid one.
    if (inValue !== undefined) {
      if (!FILTER_NAME_RE.test(inValue) || (!SOURCE_INPUTS.has(inValue) && !filterState?.results.has(inValue))) {
        return reject('ورودی فیلتر SVG به نتیجهای در همین فیلتر اشاره نمیکند.', 'svg-invalid-reference', 'in')
      }
    }
    if (resultValue !== undefined) {
      if (!FILTER_NAME_RE.test(resultValue) || SOURCE_INPUTS.has(resultValue) || !filterState) {
        return reject(`مقدار ویژگی «result» در SVG غیرمجاز است.`, 'svg-invalid-value', 'result')
      }
      if (filterState.results.has(resultValue)) {
        return reject('نام نتیجهٔ فیلتر SVG تکراری است.', 'svg-too-complex', 'result')
      }
      filterState.results.add(resultValue)
    }
    if (stdDeviationValue !== undefined && !stdDeviationIsSafe(stdDeviationValue)) {
      return reject('شعاع تار کردن فیلتر SVG بیش از حد مجاز یا نامعتبر است.', 'svg-invalid-value', 'stdDeviation')
    }
    if (filterUnitsValue !== undefined && !FILTER_UNITS.test(filterUnitsValue)) {
      return reject(`مقدار ویژگی «filterUnits» در SVG غیرمجاز است.`, 'svg-invalid-value', 'filterUnits')
    }
    if (primitiveUnitsValue !== undefined && !FILTER_UNITS.test(primitiveUnitsValue)) {
      return reject(`مقدار ویژگی «primitiveUnits» در SVG غیرمجاز است.`, 'svg-invalid-value', 'primitiveUnits')
    }
    if (colorInterpolationValue !== undefined && !COLOR_INTERPOLATION.test(colorInterpolationValue)) {
      return reject(
        `مقدار ویژگی «color-interpolation-filters» در SVG غیرمجاز است.`,
        'svg-invalid-value',
        'color-interpolation-filters',
      )
    }
    if (edgeModeValue !== undefined && !EDGE_MODE.test(edgeModeValue)) {
      return reject(`مقدار ویژگی «edgeMode» در SVG غیرمجاز است.`, 'svg-invalid-value', 'edgeMode')
    }

    // A tag that is not self-closing but has no attributes still passes through the
    // same path above; an `svg` root must be the first element.
    if (stack.length === 0 && name !== 'svg') {
      return reject('عنصر اصلی باید <svg> باشد.', 'svg-invalid-root')
    }
    if (selfClosing) {
      if (stack.length === 0) rootClosed = true
    } else {
      stack.push(entry)
    }
  }

  if (stack.length !== 0 || !rootClosed) {
    return reject('تگهای SVG درست بسته نشدهاند.', 'svg-unclosed')
  }

  // Every local reference resolves inside this document, and a filter reference
  // resolves to a real `<filter>` — not a gradient, a shape or a missing id.
  for (const ref of state.refs) {
    const target = ids.get(ref.id)
    if (!target) {
      return reject(
        `ارجاع «#${ref.id}» به عنصری در همین سند اشاره نمیکند.`,
        'svg-invalid-reference',
        ref.id,
      )
    }
    if (
      (ref.expects === 'filter' && target !== 'filter') ||
      (ref.expects === 'clippath' && target !== 'clippath') ||
      (ref.expects === 'mask' && target !== 'mask') ||
      (ref.expects === 'paint' && !PAINT_ELEMENTS.has(target))
    ) {
      return reject(
        `ارجاع «#${ref.id}» به عنصر مجازی برای این ویژگی اشاره نمیکند.`,
        'svg-invalid-reference',
        ref.id,
      )
    }
  }

  return { ok: true, svg: text }
}

/**
 * Whether an upload is, or claims to be, an SVG: by declared type, by name, **or by
 * content**. The last matters most — the first two are the uploader's word, and an SVG
 * wearing a `.png` name must not skip the allowlist because it was labelled honestly
 * nowhere.
 *
 * The content scan is skipped for a file that opens with a raster signature. A browser
 * never renders those bytes as SVG, and they routinely carry `<svg` in metadata: C2PA
 * Content Credentials (every AI-generated render) embed the generator's icon as SVG in
 * a `caBX` chunk a few hundred bytes in, which sent real 2 MB PNGs to the SVG size cap.
 */
export const looksLikeSvg = (file: { data?: Buffer; mimetype?: string; name?: string }): boolean =>
  file.mimetype === 'image/svg+xml' ||
  /\.svg$/i.test(file.name ?? '') ||
  (file.data && !hasRasterSignature(file.data)
    ? /<svg[\s>]/i.test(file.data.subarray(0, 4096).toString('latin1'))
    : false)

/** PNG, JPEG, GIF, WebP, AVIF — the raster types `Media.mimeTypes` admits. */
const hasRasterSignature = (data: Buffer): boolean => {
  const head = data.subarray(0, 12).toString('latin1')
  return (
    head.startsWith('\x89PNG\r\n\x1a\n') ||
    head.startsWith('\xff\xd8\xff') ||
    head.startsWith('GIF8') ||
    (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') ||
    /^ftypavi[fs]$/.test(head.slice(4, 12))
  )
}
