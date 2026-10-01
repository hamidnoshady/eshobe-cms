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
 * The cost is honest: an SVG using `<filter>`, `<image>`, animation or links is refused,
 * and the customer exports it without them (a logo needs none). This is defence in depth
 * with two other layers: Payload's own `validateSvg` pattern screen runs afterwards on
 * the result, and the file route answers SVG with `Content-Security-Policy: script-src
 * 'none'` (`src/storage/adapter.ts`, Payload's local handler).
 */

/** An SVG logo is a few KB. Anything near this is a photograph in a costume. */
export const MAX_SVG_BYTES = 200 * 1024

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
])

/** A tag, in one anchored piece: `<name attr="v" attr='v' flag />` or `</name>`. */
const TAG =
  /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z_:][A-Za-z0-9_:.-]*(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'))?)*)\s*(\/?)>/y
const ATTR = /\s+([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"<]*)"|'([^'<]*)'))?/g

/** `url(...)` may only point at an id inside this same document. */
const BAD_URL = /url\(\s*(?!["']?\s*#)/i
/** Values that reach out of the document or execute, in any casing or spacing. */
const BAD_VALUE = /javascript:|vbscript:|data:|expression\s*\(|-moz-binding|behavior\s*:|@import|[\\]/i

export type SvgResult = { ok: false; reason: string } | { ok: true; svg: string }

const reject = (reason: string): SvgResult => ({ ok: false, reason })

/** A `<style>` body or `style=""` value: declarations only, nothing that fetches. */
const cssIsSafe = (css: string): boolean => {
  if (BAD_VALUE.test(css) || BAD_URL.test(css)) return false
  // No `&` (entities can spell the banned words), no `<`, no comment openers inside
  // (comments are stripped from the whole document before this runs).
  return !/[&<]/.test(css)
}

/**
 * Validate an uploaded SVG. On success `svg` is the text to store: the input with its
 * comments and XML declaration removed, trimmed, nothing else changed.
 */
export const validateSvgUpload = (input: Buffer | string): SvgResult => {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input) : input.length
  if (bytes === 0) return reject('فایل SVG خالی است.')
  if (bytes > MAX_SVG_BYTES) return reject('فایل SVG بزرگ‌تر از ۲۰۰ کیلوبایت است.')

  let text = typeof input === 'string' ? input : input.toString('utf8')
  // A byte-order mark or replacement characters mean this was not UTF-8 text.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (text.includes('�') || text.includes('\0')) return reject('فایل SVG باید متن UTF-8 معتبر باشد.')

  // Nothing but the drawing may remain: no DTD, no entity, no processing instruction,
  // no CDATA. Rejected outright rather than stripped — see the file header.
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) return reject('SVG شامل DOCTYPE، ENTITY یا CDATA است.')

  // The two things that carry nothing: comments, and one leading XML declaration.
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  if (text.includes('<!--') || text.includes('-->')) return reject('SVG شامل توضیح ناقص است.')
  text = text.trim().replace(/^<\?xml\s[^>?]*\?>\s*/i, '').trim()
  if (text.includes('<?')) return reject('SVG شامل دستور پردازشی (processing instruction) است.')

  if (!/^<svg[\s>]/i.test(text) || !/(?:<\/svg\s*|\/)>$/i.test(text)) {
    return reject('فایل با <svg> شروع و با </svg> تمام نمی‌شود.')
  }

  const stack: string[] = []
  let pos = 0
  let rootClosed = false

  while (pos < text.length) {
    if (text[pos] !== '<') {
      // Character data up to the next tag.
      const next = text.indexOf('<', pos)
      const chunk = text.slice(pos, next === -1 ? text.length : next)
      const parent = stack[stack.length - 1]
      if (chunk.trim() !== '') {
        if (rootClosed || !parent || !TEXT_ELEMENTS.has(parent)) {
          return reject('SVG شامل متن در جای غیرمجاز است.')
        }
        if (parent === 'style') {
          if (!cssIsSafe(chunk)) return reject('استایل داخل SVG غیرمجاز است.')
        } else if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(chunk)) {
          return reject('SVG شامل entity ناشناخته است.')
        }
      }
      pos = next === -1 ? text.length : next
      continue
    }

    TAG.lastIndex = pos
    const match = TAG.exec(text)
    // A `<` that does not begin a well-formed tag is not something to guess about.
    if (!match) return reject('SVG شامل نشانه‌گذاری نامعتبر است.')
    pos = TAG.lastIndex

    const [, closing, rawName, rawAttrs, selfClosing] = match
    const name = rawName.toLowerCase()
    if (!ELEMENTS.has(name)) return reject(`عنصر «${rawName}» در SVG مجاز نیست.`)
    if (rootClosed) return reject('SVG بعد از پایان عنصر اصلی محتوا دارد.')

    if (closing) {
      if (rawAttrs.trim() !== '' || selfClosing) return reject('تگ پایانی SVG نامعتبر است.')
      if (stack.pop() !== name) return reject('تگ‌های SVG درست بسته نشده‌اند.')
      if (stack.length === 0) rootClosed = true
      continue
    }

    const seen = new Set<string>()
    ATTR.lastIndex = 0
    for (let attr = ATTR.exec(rawAttrs); attr; attr = ATTR.exec(rawAttrs)) {
      const attrName = attr[1].toLowerCase()
      const value = attr[2] ?? attr[3] ?? ''
      if (seen.has(attrName)) return reject(`ویژگی «${attr[1]}» تکراری است.`)
      seen.add(attrName)
      if (attrName.startsWith('on') || !ATTRIBUTES.has(attrName)) {
        return reject(`ویژگی «${attr[1]}» در SVG مجاز نیست.`)
      }
      if (attrName === 'style') {
        if (!cssIsSafe(value)) return reject('ویژگی style در SVG غیرمجاز است.')
      } else if (BAD_VALUE.test(value) || BAD_URL.test(value) || /[&]/.test(value)) {
        return reject(`مقدار ویژگی «${attr[1]}» در SVG غیرمجاز است.`)
      }
      if (attrName === 'href' || attrName === 'xlink:href') {
        // `use` may reference a shape in this document; nothing may fetch anything.
        if (name !== 'use' || !/^#[A-Za-z0-9_.:-]+$/.test(value)) {
          return reject('ارجاع خارج از سند (href) در SVG مجاز نیست.')
        }
      }
    }
    // A tag that is not self-closing but has no attributes still passes through the
    // same path above; an `svg` root must be the first element.
    if (stack.length === 0 && name !== 'svg') return reject('عنصر اصلی باید <svg> باشد.')

    if (selfClosing) {
      if (stack.length === 0) rootClosed = true
    } else {
      stack.push(name)
    }
  }

  if (stack.length !== 0 || !rootClosed) return reject('تگ‌های SVG درست بسته نشده‌اند.')
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
