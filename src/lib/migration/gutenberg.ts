import { decodeHtmlEntities } from '@/lib/html-text'

/**
 * WordPress block/HTML content → Lexical (issue #166 §3).
 *
 * The converter accepts the two shapes the REST API actually serves —
 * `content.raw` (Gutenberg block comments around HTML, `context=edit`) and
 * `content.rendered` (plain HTML) — and emits exactly the node vocabulary
 * the platform's editor enables: paragraphs, h1–h4, quotes, lists, a
 * horizontal rule, formatted text, links and line breaks. Everything richer
 * degrades *visibly*: an unknown builder block contributes its readable
 * text plus a named warning, scripts/iframes/shortcode output are dropped,
 * and the entry keeps the source HTML verbatim in `preservedHtml` for the
 * manual rebuild those blocks were always going to need. Nothing here
 * executes or embeds source markup — the same refuse-don't-render stance as
 * the SVG allowlist.
 */

type Node = Record<string, unknown>
type Direction = 'ltr' | 'rtl'

export type LexicalConversion = {
  lexical: { root: Node }
  unsupportedBlocks: string[]
  warnings: string[]
}

const textNode = (text: string, format = 0): Node => ({
  detail: 0,
  format,
  mode: 'normal',
  style: '',
  text,
  type: 'text',
  version: 1,
})

const elementNode = (
  type: string,
  children: Node[],
  direction: Direction,
  extra: Node = {},
): Node => ({
  children,
  direction,
  format: '',
  indent: 0,
  type,
  version: 1,
  ...extra,
})

const paragraphNode = (children: Node[], direction: Direction): Node =>
  elementNode('paragraph', children, direction, { textFormat: 0, textStyle: '' })

const FORMAT_BITS: Record<string, number> = {
  b: 1,
  code: 16,
  del: 4,
  em: 2,
  i: 2,
  s: 4,
  strike: 4,
  strong: 1,
  sub: 32,
  sup: 64,
  u: 8,
}

const SAFE_LINK = /^(https?:|mailto:|tel:|\/|#)/i

const attribute = (attrs: string, name: string): null | string => {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))

  return match ? decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '') : null
}

/** HTML inline markup → Lexical inline nodes, merging equally-formatted neighbours. */
const inlineNodes = (html: string, direction: Direction, warnings: Set<string>): Node[] => {
  const out: Node[] = []
  const formatStack: { bit: number; tag: string }[] = []
  const linkStack: { children: Node[]; url: null | string }[] = []

  const currentChildren = (): Node[] =>
    linkStack.length ? linkStack[linkStack.length - 1]!.children : out
  const currentFormat = (): number => formatStack.reduce((bits, entry) => bits | entry.bit, 0)

  const pushText = (raw: string): void => {
    const text = decodeHtmlEntities(raw).replace(/[ \t\f\v]+/g, ' ')
    if (!text) return

    const children = currentChildren()
    const format = currentFormat()
    const last = children[children.length - 1]

    if (last && last.type === 'text' && last.format === format) {
      last.text = String(last.text) + text
    } else {
      children.push(textNode(text, format))
    }
  }

  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+/g
  let match: RegExpExecArray | null

  while ((match = token.exec(html)) !== null) {
    const whole = match[0]

    if (!whole.startsWith('<')) {
      pushText(whole)
      continue
    }
    if (whole.startsWith('<!--')) continue

    const closing = match[1] === '/'
    const tag = (match[2] ?? '').toLowerCase()
    const attrs = match[3] ?? ''

    if (tag === 'br') {
      currentChildren().push({ type: 'linebreak', version: 1 })
      continue
    }
    if (tag === 'img') {
      const alt = closing ? null : attribute(attrs, 'alt')
      if (alt) pushText(` [${alt}] `)
      continue
    }
    if (tag === 'a') {
      if (closing) {
        const link = linkStack.pop()
        if (link) {
          if (link.url && link.children.length) {
            out.push({
              ...elementNode('link', link.children, direction),
              fields: { linkType: 'custom', newTab: false, url: link.url },
              version: 3,
            })
          } else {
            out.push(...link.children)
          }
        }
      } else {
        const href = attribute(attrs, 'href')
        const safe = href && SAFE_LINK.test(href) ? href : null
        if (href && !safe) warnings.add('یک پیوند با پروتکل ناامن حذف و متن آن نگه داشته شد.')
        linkStack.push({ children: [], url: safe })
      }
      continue
    }

    const bit = FORMAT_BITS[tag]
    if (bit !== undefined) {
      if (closing) {
        const index = [...formatStack].reverse().findIndex((entry) => entry.tag === tag)
        if (index >= 0) formatStack.splice(formatStack.length - 1 - index, 1)
      } else {
        formatStack.push({ bit, tag })
      }
    }
    // Every other inline tag is transparent: its text survives, its markup does not.
  }

  // Unclosed anchors: keep the text, drop the link.
  while (linkStack.length) out.push(...linkStack.pop()!.children)

  return out.filter((node) => node.type !== 'text' || String(node.text).length > 0)
}

const stripTrailingSpace = (children: Node[]): Node[] => {
  const trimmed = children.map((node) => {
    if (node.type !== 'text') return node
    return { ...node }
  })

  const firstText = trimmed.find((node) => node.type === 'text')
  const lastText = [...trimmed].reverse().find((node) => node.type === 'text')
  if (firstText) firstText.text = String(firstText.text).replace(/^ +/, '')
  if (lastText) lastText.text = String(lastText.text).replace(/ +$/, '')

  return trimmed.filter((node) => node.type !== 'text' || String(node.text) !== '')
}

const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'ul', 'ol', 'hr']

const listNode = (html: string, ordered: boolean, direction: Direction, warnings: Set<string>): Node => {
  const items = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item, index) => {
    const checked = /type\s*=\s*["']?checkbox[^>]*checked/i.test(item[1]!) || /data-checked\s*=\s*["']true/i.test(item[1]!)

    return elementNode('listitem', stripTrailingSpace(inlineNodes(item[1]!, direction, warnings)), direction, {
      checked,
      value: index + 1,
    })
  })

  return elementNode('list', items, direction, {
    listType: ordered ? 'number' : 'bullet',
    start: 1,
    tag: ordered ? 'ol' : 'ul',
  })
}

/** Rendered HTML → block nodes. Unknown containers recurse; tables flatten to lines. */
const htmlToBlocks = (html: string, direction: Direction, warnings: Set<string>): Node[] => {
  const cleaned = html.replace(/<(script|style|noscript|iframe|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, () => {
    warnings.add('بخشی اجرایی/جاسازی‌شده از متن مبدأ حذف شد؛ اصل آن در preservedHtml مانده است.')
    return ' '
  })

  const out: Node[] = []
  const remainder: string[] = []
  const pattern = new RegExp(
    `<(${BLOCK_TAGS.join('|')})\\b[^>]*>([\\s\\S]*?)<\\/\\1>|<(hr)\\b[^>]*\\/?>|<table\\b[^>]*>([\\s\\S]*?)<\\/table>`,
    'gi',
  )
  let lastIndex = 0
  let match: RegExpExecArray | null

  const flushRemainder = (text: string): void => {
    const chunks = text.split(/<\/(div|section|article|main|header|footer)>/gi)

    for (const chunk of chunks) {
      const children = stripTrailingSpace(
        inlineNodes(chunk.replace(/<[^>]+>/g, (tag) => tag, ), direction, warnings),
      )
      if (children.length) out.push(paragraphNode(children, direction))
    }
  }

  while ((match = pattern.exec(cleaned)) !== null) {
    remainder.push(cleaned.slice(lastIndex, match.index))
    lastIndex = pattern.lastIndex

    const tag = (match[1] ?? match[3] ?? '').toLowerCase()
    const inner = match[2] ?? ''

    if (match[4] !== undefined) {
      for (const row of match[4].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
          .map((cell) =>
            cell[1]!
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim(),
          )
          .filter(Boolean)
        if (cells.length) {
          out.push(paragraphNode([textNode(decodeHtmlEntities(cells.join(' | ')))], direction))
        }
      }
      continue
    }
    if (tag === 'hr') {
      out.push({ type: 'horizontalrule', version: 1 })
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      flushBefore(out, remainder, direction, warnings)
      out.push(listNode(match[0], tag === 'ol', direction, warnings))
      continue
    }
    if (tag === 'figure') {
      // The image itself arrives through the media channel (featured/gallery);
      // the caption text is what belongs in the flow.
      const caption = inner.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1]
      const alt = inner.match(/<img\b[^>]*>/i)?.[0]
      const captionText = caption ?? (alt ? '' : inner)
      const children = stripTrailingSpace(inlineNodes(captionText, direction, warnings))
      if (children.length) out.push(paragraphNode(children, direction))
      continue
    }

    flushBefore(out, remainder, direction, warnings)

    if (tag === 'pre') {
      const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim()
      if (text) out.push(elementNode('quote', [textNode(text, 16)], direction))
      continue
    }
    if (tag === 'blockquote') {
      const children = stripTrailingSpace(
        inlineNodes(inner.replace(/<\/?p\b[^>]*>/gi, ' '), direction, warnings),
      )
      if (children.length) out.push(elementNode('quote', children, direction))
      continue
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(4, Number(tag.slice(1)))
      const children = stripTrailingSpace(inlineNodes(inner, direction, warnings))
      if (children.length) {
        out.push(elementNode('heading', children, direction, { tag: `h${level}` }))
      }
      continue
    }

    const children = stripTrailingSpace(inlineNodes(inner, direction, warnings))
    if (children.length) out.push(paragraphNode(children, direction))
  }

  remainder.push(cleaned.slice(lastIndex))
  flushRemainder(remainder.join(' '))

  return out

  function flushBefore(
    target: Node[],
    chunks: string[],
    dir: Direction,
    warns: Set<string>,
  ): void {
    const text = chunks.splice(0, chunks.length).join(' ')
    const children = stripTrailingSpace(inlineNodes(text, dir, warns))
    if (children.length) target.push(paragraphNode(children, dir))
  }
}

const KNOWN_BLOCKS = new Set([
  'core/paragraph',
  'core/heading',
  'core/list',
  'core/quote',
  'core/separator',
  'core/spacer',
  'core/code',
  'core/preformatted',
  'core/freeform',
  'core/html',
  'core/image',
  'core/gallery',
  'core/group',
  'core/columns',
  'core/column',
  'core/table',
  'core/more',
])

/**
 * Split Gutenberg-serialized content into (block name, inner HTML) parts.
 * Comments without the `wp:` prefix and everything between blocks is
 * freeform HTML. Nested known containers recurse in the caller.
 */
const splitGutenberg = (raw: string): { html: string; name: null | string }[] => {
  const parts: { html: string; name: null | string }[] = []
  const open = /<!--\s*wp:([a-z0-9/-]+)(?:\s+(\{[\s\S]*?\}))?\s*(\/)?-->/gi
  let last = 0
  let match: RegExpExecArray | null

  while ((match = open.exec(raw)) !== null) {
    if (match.index > last) parts.push({ html: raw.slice(last, match.index), name: null })

    const name = match[1]!
    if (match[3]) {
      parts.push({ html: '', name })
      last = open.lastIndex
      continue
    }

    const closeTag = `<!-- /wp:${name} -->`
    const closeIndex = raw.indexOf(closeTag, open.lastIndex)

    if (closeIndex === -1) {
      parts.push({ html: raw.slice(open.lastIndex), name })
      last = raw.length
      break
    }

    parts.push({ html: raw.slice(open.lastIndex, closeIndex), name })
    last = closeIndex + closeTag.length
    open.lastIndex = last
  }

  if (last < raw.length) parts.push({ html: raw.slice(last), name: null })

  return parts
}

export const wordpressContentToLexical = (
  input: null | string | undefined,
  { locale = 'fa' }: { locale?: string } = {},
): LexicalConversion => {
  const direction: Direction = /^(fa|ar|he|ur)/.test(locale) ? 'rtl' : 'ltr'
  const warnings = new Set<string>()
  const unsupported = new Set<string>()
  const source = typeof input === 'string' ? input : ''
  const children: Node[] = []

  if (/\[(\w[\w-]*)(?:\s[^\]]*)?\]/.test(source)) {
    warnings.add('متن حاوی شورت‌کد است؛ خروجی افزونه اجرا نمی‌شود و برای بازبینی دستی می‌ماند.')
  }

  for (const part of splitGutenberg(source)) {
    if (part.name === null) {
      children.push(...htmlToBlocks(part.html, direction, warnings))
      continue
    }

    const name = part.name.includes('/') ? part.name : `core/${part.name}`

    if (!KNOWN_BLOCKS.has(name)) {
      unsupported.add(name)
      warnings.add(`بلوک «${name}» معادل بومی ندارد؛ متن خوانای آن وارد و بلوک برای بازسازی دستی نشانه‌گذاری شد.`)
      children.push(...htmlToBlocks(part.html, direction, warnings))
      continue
    }

    if (name === 'core/separator') {
      children.push({ type: 'horizontalrule', version: 1 })
      continue
    }
    if (name === 'core/spacer' || name === 'core/more') continue

    children.push(...htmlToBlocks(part.html, direction, warnings))
  }

  if (children.length === 0) children.push(paragraphNode([], direction))

  return {
    lexical: {
      root: elementNode('root', children, direction),
    },
    unsupportedBlocks: [...unsupported].sort(),
    warnings: [...warnings],
  }
}
